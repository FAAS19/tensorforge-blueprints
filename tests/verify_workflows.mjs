/**
 * Zero-dependency Node.js verification & security test suite for TraceLabs n8n Workflow Pack.
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

test("All 3 n8n workflow files have valid graph topology, webhook headerAuth, and non-leaking receipts", () => {
  const files = [
    "01_clinical_referral_to_cliniko.json",
    "02_supplier_invoice_to_xero.json",
    "03_inbound_lead_triage_to_slack.json",
  ];
  for (const file of files) {
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

    const respondNode = wf.nodes.find((n) => n.type === "n8n-nodes-base.respondToWebhook");
    assert.ok(respondNode, `${file} missing respondToWebhook node`);
    assert.notEqual(
      respondNode.parameters.responseBody,
      "={{ JSON.stringify($json) }}",
      `${file}: respondToWebhook must not echo full downstream $json`
    );

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
});

test("Workflow 01: Clinical Referral validates Medicare & Provider checksums, blocks invalid urgency/DOB, and redacts PHI on quarantine", () => {
  const wf = loadWorkflow("01_clinical_referral_to_cliniko.json");

  const validOut = runCodeNode(wf, "code-medicare-provider-guard", fixtures.referral_valid);
  assert.equal(validOut.json.status, "committed");
  assert.equal(validOut.json.cliniko_patient_payload.first_name, "Lachlan");
  assert.equal(validOut.json.cliniko_patient_payload.last_name, "Vance");
  assert.equal(validOut.json.cliniko_patient_payload.medicare, "2123-45670-1");

  const badOut = runCodeNode(wf, "code-medicare-provider-guard", fixtures.referral_hallucinated);
  assert.equal(badOut.json.status, "quarantined_dlq");
  assert.equal(badOut.json.patient_initials, "L.V.");
  assert.equal(badOut.json.raw_payload, undefined, "Should not leak raw PHI payload into DLQ object");
  const failedFields = new Set(badOut.json.violations.map((v) => v.field));
  assert.ok(failedFields.has("date_of_birth"), "Should catch impossible calendar date 2026-02-31");
  assert.ok(failedFields.has("medicare_number"), "Should catch bad Medicare checksum");
  assert.ok(failedFields.has("referring_provider_no"), "Should catch bad Provider PLV checksum");

  const badUrgency = runCodeNode(wf, "code-medicare-provider-guard", {
    ...fixtures.referral_valid,
    urgency_tier: "<!channel> override",
  });
  assert.equal(badUrgency.json.status, "quarantined_dlq");
  assert.ok(badUrgency.json.violations.some((v) => v.field === "urgency_tier"));
});

test("Workflow 02: Supplier Invoice validates ATO ABN modulo-89, GST arithmetic, and line_items subtotal match", () => {
  const wf = loadWorkflow("02_supplier_invoice_to_xero.json");

  const validOut = runCodeNode(wf, "code-abn-gst-guard", fixtures.invoice_valid);
  assert.equal(validOut.json.status, "committed");
  const xeroInv = validOut.json.xero_invoice_payload.Invoices[0];
  assert.equal(xeroInv.Type, "ACCPAY");
  assert.equal(xeroInv.Contact.TaxNumber, "51 824 753 556");
  assert.equal(xeroInv.LineItems[0].UnitAmount, 1000);

  const badOut = runCodeNode(wf, "code-abn-gst-guard", fixtures.invoice_mismatched);
  assert.equal(badOut.json.status, "quarantined_dlq");
  const failedFields = new Set(badOut.json.violations.map((v) => v.field));
  assert.ok(failedFields.has("supplier_abn"), "Should catch bad ATO ABN modulo-89");
  assert.ok(failedFields.has("total_cents"), "Should catch subtotal + gst != total mismatch");

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

test("Workflow 03: Service Enquiry normalises +61 AU phone, enforces intent_tier allowlist, and neutralises Slack injection", () => {
  const wf = loadWorkflow("03_inbound_lead_triage_to_slack.json");

  const validOut = runCodeNode(wf, "code-lead-normaliser", fixtures.enquiry_qualified);
  assert.equal(validOut.json.status, "committed");
  assert.equal(validOut.json.lead.phone, "+61412345678");
  assert.equal(validOut.json.hubspot_contact_payload.properties.hs_lead_status, "OPEN_DEAL");

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
