/**
 * Zero-dependency Node.js verification & security test suite for TensorForge n8n Workflow Pack.
 * Executes the actual JavaScript Code Nodes inside each .json workflow against
 * valid, hallucinated, and adversarial Australian clinical, accounting, and enquiry payloads.
 *
 * Run: node --test tests/verify_workflows.mjs
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const workflowsDir = path.join(rootDir, "workflows");
const fixtures = JSON.parse(
  fs.readFileSync(path.join(rootDir, "examples", "sample_webhook_payloads.json"), "utf8")
);

function loadWorkflow(filename) {
  const fullPath = path.join(workflowsDir, filename);
  return JSON.parse(fs.readFileSync(fullPath, "utf8"));
}

function runCodeNode(workflow, codeNodeId, claudeExtractedObj) {
  const node = workflow.nodes.find((n) => n.id === codeNodeId);
  assert.ok(node, `Missing code node ${codeNodeId}`);
  const fn = new Function(
    "$input",
    node.parameters.jsCode
  );
  const mockInput = {
    item: {
      json: {
        content: [{ text: JSON.stringify(claudeExtractedObj) }],
      },
    },
  };
  return fn(mockInput);
}

function evalN8nExpression(exprStr, { $json = {}, nodes = {}, $env = {} } = {}) {
  assert.ok(exprStr.startsWith("={{") && exprStr.endsWith("}}"), `Expected n8n expression, got: ${exprStr}`);
  const inner = exprStr.slice(3, -2).trim();
  const $ = (nodeName) => {
    if (!(nodeName in nodes)) {
      throw new Error(`Referenced unknown or unexecuted node '${nodeName}'`);
    }
    return { item: { json: nodes[nodeName] } };
  };
  const fn = new Function("$json", "$", "$env", `return (${inner});`);
  return fn($json, $, $env);
}

test("All 3 n8n workflow files have valid graph topology, webhook headerAuth, and non-leaking receipts", () => {
  const specs = [
    {
      file: "01_clinical_referral_to_cliniko.json",
      gateName: "AU Medicare & Provider Checksum Gate",
      gateId: "code-medicare-provider-guard",
      claudeId: "claude-referral-extractor",
    },
    {
      file: "02_supplier_invoice_to_xero.json",
      gateName: "ATO ABN Modulo-89 & GST Balance Gate",
      gateId: "code-abn-gst-guard",
      claudeId: "claude-invoice-extractor",
    },
    {
      file: "03_inbound_lead_triage_to_slack.json",
      gateName: "AU Phone (+61) & Spam Filter Gate",
      gateId: "code-lead-normaliser",
      claudeId: "claude-enquiry-classifier",
    },
  ];

  for (const { file, gateName, claudeId } of specs) {
    const wf = loadWorkflow(file);
    assert.ok(wf.name, `${file} missing name`);
    assert.ok(Array.isArray(wf.nodes) && wf.nodes.length >= 6, `${file} needs >= 6 nodes`);

    const webhookNode = wf.nodes.find((n) => n.type === "n8n-nodes-base.webhook");
    assert.ok(webhookNode, `${file} missing webhook trigger`);
    assert.equal(
      webhookNode.parameters.authentication,
      "headerAuth",
      `${file}: webhook must enforce headerAuth`
    );

    // Verify Claude extractor unwraps Webhook v2 $json.body and never leaks $json.headers
    const claudeNode = wf.nodes.find((n) => n.id === claudeId);
    assert.ok(claudeNode, `${file} missing Claude extractor node`);
    const webhookV2Input = {
      headers: {
        "x-tensorforge-webhook-secret": "super-secret-header-token-do-not-leak",
      },
      body: {
        referral_text: "Sample referral body",
        invoice_text: "Sample invoice body",
        contact_email: "test@example.com.au",
      },
    };
    const claudeBodyStr = evalN8nExpression(claudeNode.parameters.jsonBody, {
      $json: webhookV2Input,
    });
    assert.ok(
      !claudeBodyStr.includes("super-secret-header-token-do-not-leak"),
      `${file}: Claude extractor must never leak $json.headers secret to Anthropic API`
    );

    // Also verify top-level manual/test invocation (without $json.body wrapper) strips $json.headers
    const flatWebhookInput = {
      headers: {
        "x-tensorforge-webhook-secret": "super-secret-flat-header-token-do-not-leak",
      },
      contact_email: "test@example.com.au",
    };
    const claudeFlatBodyStr = evalN8nExpression(claudeNode.parameters.jsonBody, {
      $json: flatWebhookInput,
    });
    assert.ok(
      !claudeFlatBodyStr.includes("super-secret-flat-header-token-do-not-leak"),
      `${file}: Claude extractor must strip $json.headers even when $json.body is absent`
    );

    const respondNode = wf.nodes.find((n) => n.type === "n8n-nodes-base.respondToWebhook");
    assert.ok(respondNode, `${file} missing respondToWebhook node`);
    assert.notEqual(
      respondNode.parameters.responseBody,
      "={{ JSON.stringify($json) }}",
      `${file}: respondToWebhook must not echo full downstream $json`
    );

    // Simulate Slack DLQ overwriting $json with { ok: true } and verify receipt still reports quarantined_dlq
    const dlqReceipt = JSON.parse(
      evalN8nExpression(respondNode.parameters.responseBody, {
        $json: { ok: true },
        nodes: { [gateName]: { status: "quarantined_dlq" } },
      })
    );
    assert.equal(
      dlqReceipt.status,
      "quarantined_dlq",
      `${file}: respondToWebhook must preserve quarantined_dlq status after Slack HTTP node overwrites $json`
    );
    assert.equal(dlqReceipt.received, true);

    const committedReceipt = JSON.parse(
      evalN8nExpression(respondNode.parameters.responseBody, {
        $json: { id: "downstream-record-123" },
        nodes: { [gateName]: { status: "committed" } },
      })
    );
    assert.equal(committedReceipt.status, "committed");

    const nodeNames = new Set(wf.nodes.map((n) => n.name));
    for (const [sourceName, targets] of Object.entries(wf.connections)) {
      assert.ok(nodeNames.has(sourceName), `${file}: unknown connection source '${sourceName}'`);
      for (const branch of targets.main) {
        for (const edge of branch) {
          assert.ok(
            nodeNames.has(edge.node),
            `${file}: unknown connection target '${edge.node}'`
          );
        }
      }
    }
  }

  // Verify Cliniko User-Agent and README use generic contact@tensorforge.dev and no other @tensorforge.dev address appears
  const wf01Raw = fs.readFileSync(path.join(workflowsDir, "01_clinical_referral_to_cliniko.json"), "utf8");
  assert.ok(
    wf01Raw.includes("TensorForge-Intake-Pipeline (contact@tensorforge.dev)"),
    "01_clinical_referral_to_cliniko.json must use contact@tensorforge.dev in Cliniko User-Agent"
  );
  const readmeRaw = fs.readFileSync(path.join(rootDir, "README.md"), "utf8");
  assert.ok(
    readmeRaw.includes("mailto:contact@tensorforge.dev"),
    "README.md must reference mailto:contact@tensorforge.dev"
  );
  for (const relPath of [
    "README.md",
    "LICENSE",
    "examples/sample_webhook_payloads.json",
    "workflows/01_clinical_referral_to_cliniko.json",
    "workflows/02_supplier_invoice_to_xero.json",
    "workflows/03_inbound_lead_triage_to_slack.json",
  ]) {
    const content = fs.readFileSync(path.join(rootDir, relPath), "utf8");
    const emails = content.match(/[a-z0-9._%+-]+@tensorforge\.dev/gi) || [];
    for (const email of emails) {
      assert.equal(
        email.toLowerCase(),
        "contact@tensorforge.dev",
        `${relPath} must only use generic contact@tensorforge.dev (found ${email})`
      );
    }
  }
});

test("Workflow 01: Clinical Referral validates 11-digit Medicare & Provider checksums, preserves unescaped Cliniko JSON, and redacts PHI on quarantine", () => {
  const wf = loadWorkflow("01_clinical_referral_to_cliniko.json");

  const validOut = runCodeNode(wf, "code-medicare-provider-guard", {
    ...fixtures.referral_valid,
    notes: "Refer to Foot & Ankle Clinic.",
  });
  assert.equal(validOut.json.status, "committed");
  assert.equal(validOut.json.cliniko_patient_payload.first_name, "Lachlan");
  assert.equal(validOut.json.cliniko_patient_payload.last_name, "Vance");
  assert.equal(validOut.json.cliniko_patient_payload.medicare, "2123-45670-1");
  assert.equal(validOut.json.cliniko_patient_payload.medicare_reference_number, "1");
  assert.ok(
    validOut.json.cliniko_patient_payload.notes.includes("Foot & Ankle Clinic"),
    "Cliniko REST JSON must not corrupt '&' into '&amp;'"
  );
  assert.ok(!validOut.json.cliniko_patient_payload.notes.includes("&amp;"));

  // Missing 11th digit (IRN) must be quarantined rather than fabricating '1'
  const missingIrnOut = runCodeNode(wf, "code-medicare-provider-guard", {
    ...fixtures.referral_valid,
    medicare_number: "2123 45670 1",
  });
  assert.equal(missingIrnOut.json.status, "quarantined_dlq");
  assert.ok(
    missingIrnOut.json.violations.some(
      (v) => v.field === "medicare_number" && v.message.includes("11 digits")
    )
  );

  const badOut = runCodeNode(wf, "code-medicare-provider-guard", fixtures.referral_hallucinated);
  assert.equal(badOut.json.status, "quarantined_dlq");
  assert.equal(badOut.json.patient_initials, "L.V.");
  assert.equal(badOut.json.raw_payload, undefined, "Should not leak raw PHI payload into DLQ object");
  const failedFields = new Set(badOut.json.violations.map((v) => v.field));
  assert.ok(failedFields.has("date_of_birth"), "Should catch impossible calendar date 2026-02-31");
  assert.ok(
    badOut.json.violations.some(
      (v) => v.field === "medicare_number" && v.message === "Medicare checksum failed"
    ),
    "Should catch bad 11-digit Medicare modulo-10 checksum"
  );
  assert.ok(failedFields.has("referring_provider_no"), "Should catch bad Provider PLV checksum");

  const badUrgency = runCodeNode(wf, "code-medicare-provider-guard", {
    ...fixtures.referral_valid,
    first_name: "<script>Lachlan",
    urgency_tier: "<!channel> override",
  });
  assert.equal(badUrgency.json.status, "quarantined_dlq");
  assert.equal(badUrgency.json.patient_initials, "S.V.");
  assert.ok(badUrgency.json.violations.some((v) => v.field === "urgency_tier"));
});

test("Workflow 02: Supplier Invoice validates ATO ABN modulo-89, 10% GST ratio, line_items subtotal match, and unescaped Xero JSON", () => {
  const wf = loadWorkflow("02_supplier_invoice_to_xero.json");

  const validOut = runCodeNode(wf, "code-abn-gst-guard", {
    ...fixtures.invoice_valid,
    supplier_name: "Melbourne Surgical & Medical Pty Ltd",
  });
  assert.equal(validOut.json.status, "committed");
  const xeroInv = validOut.json.xero_invoice_payload.Invoices[0];
  assert.equal(xeroInv.Type, "ACCPAY");
  assert.equal(xeroInv.Contact.Name, "Melbourne Surgical & Medical Pty Ltd");
  assert.ok(!xeroInv.Contact.Name.includes("&amp;"), "Xero Contact.Name must not contain HTML entities");
  assert.equal(xeroInv.Contact.TaxNumber, "51 824 753 556");
  assert.equal(xeroInv.LineItems[0].UnitAmount, 1000);

  const badOut = runCodeNode(wf, "code-abn-gst-guard", fixtures.invoice_mismatched);
  assert.equal(badOut.json.status, "quarantined_dlq");
  const failedFields = new Set(badOut.json.violations.map((v) => v.field));
  assert.ok(failedFields.has("supplier_abn"), "Should catch bad ATO ABN modulo-89");
  assert.ok(failedFields.has("total_cents"), "Should catch subtotal + gst != total mismatch");

  // 25% GST where subtotal + gst == total must still be quarantined because TaxType INPUT forces 10% GST
  const badGstRatio = runCodeNode(wf, "code-abn-gst-guard", {
    ...fixtures.invoice_valid,
    subtotal_cents: 100000,
    gst_cents: 25000,
    total_cents: 125000,
  });
  assert.equal(badGstRatio.json.status, "quarantined_dlq");
  assert.ok(
    badGstRatio.json.violations.some((v) => v.field === "gst_cents"),
    "Should catch non-10% GST ratio when gst_cents > 0"
  );

  const tamperedLines = runCodeNode(wf, "code-abn-gst-guard", {
    ...fixtures.invoice_valid,
    line_items: [
      { description: "Inflated line item", quantity: 1, unit_amount_cents: 9900000, account_code: "400" },
    ],
  });
  assert.equal(tamperedLines.json.status, "quarantined_dlq");
  assert.ok(
    tamperedLines.json.violations.some((v) => v.field === "line_items"),
    "Should catch line_items sum mismatch against subtotal_cents"
  );
});

test("Workflow 03: Service Enquiry normalises +61 AU phone, preserves unescaped HubSpot company name, and evaluates Slack dispatch & DLQ nodes", () => {
  const wf = loadWorkflow("03_inbound_lead_triage_to_slack.json");

  const validOut = runCodeNode(wf, "code-lead-normaliser", fixtures.enquiry_qualified);
  assert.equal(validOut.json.status, "committed");
  assert.equal(validOut.json.lead.phone, "+61412345678");
  assert.equal(
    validOut.json.hubspot_contact_payload.properties.company,
    "Melbourne Spine & Sports Clinic",
    "HubSpot REST payload must preserve '&' without '&amp;' corruption"
  );
  assert.equal(validOut.json.hubspot_contact_payload.properties.hs_lead_status, "OPEN_DEAL");

  // Simulate HubSpot HTTP node overwriting $json and verify Slack Dispatch Draft Reply node succeeds
  const slackNode = wf.nodes.find((n) => n.id === "http-slack-lead-dispatch");
  assert.ok(slackNode, "Missing Slack dispatch node");
  const slackPayload = JSON.parse(
    evalN8nExpression(slackNode.parameters.jsonBody, {
      $json: { id: "hubspot-contact-991", properties: {} },
      nodes: { "AU Phone (+61) & Spam Filter Gate": validOut.json },
    })
  );
  assert.ok(slackPayload.text.includes("high_intent · 9/10"));
  assert.ok(slackPayload.text.includes("Melbourne Spine &amp; Sports Clinic"));

  // Legitimate lead with invalid phone is quarantined to Slack DLQ with contact email preserved
  const invalidPhoneLead = runCodeNode(wf, "code-lead-normaliser", {
    ...fixtures.enquiry_qualified,
    contact_phone: "12345",
  });
  assert.equal(invalidPhoneLead.json.status, "quarantined_dlq");
  assert.ok(invalidPhoneLead.json.enquiry_summary.includes("sarah.chen@melbournespine.com.au"));
  const slackDlqNode = wf.nodes.find((n) => n.id === "http-slack-enquiry-dlq");
  assert.ok(slackDlqNode, "Missing Slack Enquiry DLQ node");
  const dlqSlackPayload = JSON.parse(
    evalN8nExpression(slackDlqNode.parameters.jsonBody, {
      $json: invalidPhoneLead.json,
    })
  );
  assert.ok(dlqSlackPayload.blocks[0].text.text.includes("sarah.chen@melbournespine.com.au"));

  const spamOut = runCodeNode(wf, "code-lead-normaliser", {
    ...fixtures.enquiry_qualified,
    intent_tier: "spam_or_solicitation",
  });
  assert.equal(spamOut.json.status, "quarantined_dlq");

  const unknownTierOut = runCodeNode(wf, "code-lead-normaliser", {
    ...fixtures.enquiry_qualified,
    intent_tier: "unclassified_bypass",
  });
  assert.equal(unknownTierOut.json.status, "quarantined_dlq");

  const slackInjectionOut = runCodeNode(wf, "code-lead-normaliser", {
    ...fixtures.enquiry_qualified,
    summary_one_line: "<!channel> <https://evil.example/phish|Click here>",
  });
  assert.equal(slackInjectionOut.json.status, "committed");
  assert.ok(!slackInjectionOut.json.lead.summary_one_line.includes("<!channel>"));
  assert.ok(slackInjectionOut.json.lead.summary_one_line.includes("&lt;!channel&gt;"));
});
