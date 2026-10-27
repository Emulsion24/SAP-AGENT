
import { ChatGroq } from "@langchain/groq";
import { tool } from "@langchain/core/tools";
import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { z } from "zod";

import { datasphereGet } from "@/lib/sap-datasphere";
import { findObjectMetadata } from "@/lib/datasphere-cli";

// ------------------------------------
// Model
// ------------------------------------

const model = new ChatGroq({
  apiKey: process.env.GROQ_API_KEY,
  model: process.env.GROQ_MODEL || "openai/gpt-oss-20b",
  temperature: 0,
  maxTokens: 1200,
});

// ------------------------------------
// Shared helpers
// ------------------------------------

function getConnection(config) {
  const connection = config?.configurable?.datasphereConnection;

  if (!connection) {
    throw new Error(
      "No SAP Datasphere connection was provided. Connect first."
    );
  }

  return connection;
}

function validateId(value, label) {
  const id = String(value || "").trim();

  if (
    !id ||
    id.length > 200 ||
    /['"\\/?#\u0000-\u001f]/.test(id)
  ) {
    throw new Error(
      `Invalid ${label}. Use an ID returned by SAP Datasphere.`
    );
  }

  return id;
}

function reduceData(value, depth = 0) {
  if (depth > 4) return "[Nested data omitted]";

  if (typeof value === "string") {
    return value.length > 200
      ? `${value.slice(0, 200)}...`
      : value;
  }

  if (Array.isArray(value)) {
    const items = value
      .slice(0, 10)
      .map((item) => reduceData(item, depth + 1));

    if (value.length > 10) {
      items.push(`[${value.length - 10} additional items omitted]`);
    }

    return items;
  }

  if (value && typeof value === "object") {
    const result = {};
    const entries = Object.entries(value).slice(0, 20);

    for (const [key, item] of entries) {
      result[key] = reduceData(item, depth + 1);
    }

    if (Object.keys(value).length > 20) {
      result._note = "Additional fields omitted.";
    }

    return result;
  }

  return value;
}

function compactResult(data) {
  const serialized = JSON.stringify(reduceData(data));

  if (serialized.length <= 4000) return serialized;

  return JSON.stringify({
    truncated: true,
    message:
      "The result was shortened. Ask about a specific space or object.",
    preview: serialized.slice(0, 2500),
  });
}

function extractItems(data) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.value)) return data.value;
  if (Array.isArray(data?.assets)) return data.assets;
  if (Array.isArray(data?.items)) return data.items;
  return [];
}

function getTechnicalName(item) {
  return (
    item?.technicalName ||
    item?.assetId ||
    item?.objectId ||
    item?.id ||
    item?.name ||
    null
  );
}

function getReportedStatus(item) {
  const status = item?.status;

  if (typeof status === "string") return status;

  return (
    item?.deploymentStatus ||
    status?.deploymentStatus ||
    item?.state ||
    null
  );
}

function isReportedUnhealthy(status) {
  if (typeof status !== "string") return false;

  return /\b(broken|failed|error|invalid|undeployed|not deployed)\b/i.test(
    status
  );
}

function isFailedTaskStatus(status) {
  if (typeof status !== "string") return false;

  return /^(FAILED|ERROR|CANCELED|CANCELLED)$/i.test(status.trim());
}

function getTaskStatus(item) {
  return (
    item?.status ||
    item?.state ||
    item?.executionStatus ||
    item?.taskStatus ||
    null
  );
}

// ------------------------------------
// 1. List Datasphere spaces
// ------------------------------------

const listSpaces = tool(
  async (_, config) => {
    const connection = getConnection(config);

    const result = await datasphereGet(
      connection,
      "/api/v1/datasphere/consumption/catalog/spaces"
    );

    return compactResult(result);
  },
  {
    name: "list_datasphere_spaces",
    description:
      "List SAP Datasphere spaces accessible to the connected OAuth client.",
    schema: z.object({}),
  }
);

// ------------------------------------
// 2. List objects/assets in a space
// ------------------------------------

const listAssets = tool(
  async ({ spaceId }, config) => {
    const connection = getConnection(config);
    const space = validateId(spaceId, "space ID");

    const result = await datasphereGet(
      connection,
      `/api/v1/datasphere/consumption/catalog/spaces('${encodeURIComponent(
        space
      )}')/assets`
    );

    return compactResult(result);
  },
  {
    name: "list_datasphere_assets",
    description:
      "List catalog assets for a specific SAP Datasphere space.",
    schema: z.object({
      spaceId: z.string().min(1).max(200),
    }),
  }
);

// ------------------------------------
// 3. Inspect an asset
// ------------------------------------

const inspectAsset = tool(
  async ({ spaceId, assetId }, config) => {
    const connection = getConnection(config);
    const space = validateId(spaceId, "space ID");
    const asset = validateId(assetId, "asset ID");

    const result = await datasphereGet(
      connection,
      `/api/v1/datasphere/consumption/catalog/spaces('${encodeURIComponent(
        space
      )}')/assets('${encodeURIComponent(asset)}')`
    );

    return compactResult(result);
  },
  {
    name: "inspect_datasphere_asset",
    description:
      "Retrieve current catalog metadata for a specific asset.",
    schema: z.object({
      spaceId: z.string().min(1).max(200),
      assetId: z.string().min(1).max(200),
    }),
  }
);

// ------------------------------------
// 4. Retrieve object metadata
// ------------------------------------

const getObjectMetadata = tool(
  async ({ spaceId, objectName }, config) => {
    const connection = getConnection(config);

    const result = await findObjectMetadata({
      connection,
      spaceId: validateId(spaceId, "space ID"),
      objectName: validateId(objectName, "object name"),
    });

    return compactResult(result);
  },
  {
    name: "get_datasphere_object_metadata",
    description:
      "Retrieve object metadata, including creation, modification, deployment, and status fields when available.",
    schema: z.object({
      spaceId: z.string().min(1).max(200),
      objectName: z.string().min(1).max(200),
    }),
  }
);

// ------------------------------------
// 5. Retrieve task/execution history
// ------------------------------------

const getObjectTaskHistory = tool(
  async ({ spaceId, objectId }, config) => {
    const connection = getConnection(config);
    const space = validateId(spaceId, "space ID");
    const object = validateId(objectId, "object ID");

    const result = await datasphereGet(
      connection,
      `/api/v1/datasphere/tasks/logs/${encodeURIComponent(
        space
      )}/objects/${encodeURIComponent(object)}`
    );

    return compactResult(result);
  },
  {
    name: "get_datasphere_object_task_history",
    description:
      "Retrieve task/execution history for an object. Use detailed logs to investigate failures when supported.",
    schema: z.object({
      spaceId: z.string().min(1).max(200),
      objectId: z.string().min(1).max(200),
    }),
  }
);

// ------------------------------------
// 6. Scan a space for unhealthy objects
// ------------------------------------

const scanSpaceHealth = tool(
  async ({ spaceId, maxObjects = 30 }, config) => {
    const connection = getConnection(config);
    const space = validateId(spaceId, "space ID");
    const limit = Math.min(Math.max(maxObjects, 1), 30);

    const catalog = await datasphereGet(
      connection,
      `/api/v1/datasphere/consumption/catalog/spaces('${encodeURIComponent(
        space
      )}')/assets`
    );

    const allAssets = extractItems(catalog);
    const assets = allAssets.slice(0, limit);

    const findings = [];
    const unavailableChecks = [];
    let checkedObjects = 0;

    for (const asset of assets) {
      const objectId = getTechnicalName(asset);

      if (!objectId) {
        unavailableChecks.push({
          check: "catalog_metadata",
          message: "An asset did not include a recognizable object identifier.",
        });
        continue;
      }

      checkedObjects++;

      const objectType =
        asset.type || asset.assetType || asset.objectType || "Unknown";

      // Check status exposed by the catalog.
      const catalogStatus = getReportedStatus(asset);

      if (isReportedUnhealthy(catalogStatus)) {
        findings.push({
          objectId,
          objectType,
          category: "unhealthy_catalog_status",
          status: catalogStatus,
          evidence: "The catalog returned an unhealthy status.",
          rootCause: "Not yet confirmed.",
          recommendedAction:
            "Inspect the object definition, deployment information, and dependencies.",
        });
      }

      // Inspect individual metadata for a more complete status.
      try {
        const detail = await datasphereGet(
          connection,
          `/api/v1/datasphere/consumption/catalog/spaces('${encodeURIComponent(
            space
          )}')/assets('${encodeURIComponent(objectId)}')`
        );

        const detailStatus = getReportedStatus(detail);

        if (
          isReportedUnhealthy(detailStatus) &&
          !findings.some(
            (finding) =>
              finding.objectId === objectId &&
              finding.category === "unhealthy_catalog_status"
          )
        ) {
          findings.push({
            objectId,
            objectType:
              detail.type || detail.assetType || objectType,
            category: "unhealthy_catalog_status",
            status: detailStatus,
            evidence:
              "Detailed catalog metadata returned an unhealthy status.",
            rootCause: "Not yet confirmed.",
            recommendedAction:
              "Inspect deployment details and upstream dependencies.",
          });
        }
      } catch (error) {
        unavailableChecks.push({
          objectId,
          check: "object_metadata",
          message: String(
            error?.message || "Metadata request failed"
          ).slice(0, 200),
        });
      }

      // Check task history. Some assets do not support task logs.
      try {
        const history = await datasphereGet(
          connection,
          `/api/v1/datasphere/tasks/logs/${encodeURIComponent(
            space
          )}/objects/${encodeURIComponent(objectId)}`
        );

        const logs = extractItems(history);

        const failedLogs = logs.filter((log) =>
          isFailedTaskStatus(getTaskStatus(log))
        );

        if (failedLogs.length > 0) {
          const existing = findings.find(
            (finding) => finding.objectId === objectId
          );

          const taskEvidence = failedLogs.slice(0, 3).map((log) => ({
            status: getTaskStatus(log),
            logId: log.logId ?? log.id ?? null,
            startTime: log.startTime ?? log.startedAt ?? null,
            endTime: log.endTime ?? log.finishedAt ?? null,
            message: log.message ?? log.errorMessage ?? null,
          }));

          if (existing) {
            existing.taskEvidence = taskEvidence;
          } else {
            findings.push({
              objectId,
              objectType,
              category: "failed_execution",
              status: "Execution failure detected",
              evidence: taskEvidence,
              rootCause:
                "The execution failed, but the available history does not establish the root cause.",
              recommendedAction:
                "Inspect the detailed task log and address the underlying error before retrying.",
            });
          }
        }
      } catch (error) {
        unavailableChecks.push({
          objectId,
          check: "task_history",
          message: String(
            error?.message || "Task history request failed"
          ).slice(0, 200),
        });
      }
    }

    return compactResult({
      spaceId: space,
      scannedObjects: checkedObjects,
      catalogObjectsReturned: allAssets.length,
      scanLimit: limit,
      truncatedScan: allAssets.length > assets.length,
      findings,
      unavailableChecks: unavailableChecks.slice(0, 20),
      summary: {
        findingsCount: findings.length,
        unhealthyCatalogStatuses: findings.filter(
          (item) => item.category === "unhealthy_catalog_status"
        ).length,
        executionFailures: findings.filter(
          (item) => item.category === "failed_execution"
        ).length,
      },
      limitations: [
        "The scan only covers assets returned by the Consumption Catalog API.",
        "A catalog asset may not expose deployment status.",
        "Some asset types may not support task-history lookup.",
        "An unavailable check does not mean the object is healthy or broken.",
        "Failed execution does not automatically prove that an object definition is broken.",
        "Root causes require supporting diagnostic evidence.",
        "This scan is read-only and does not repair objects.",
      ],
    });
  },
  {
    name: "scan_datasphere_space_health",
    description:
      "Scan a Datasphere space for unhealthy statuses in catalog assets and failed task executions. Report evidence, limitations, and recommended next steps. Do not invent root causes or execute repairs.",
    schema: z.object({
      spaceId: z.string().min(1).max(200),
      maxObjects: z.number().int().min(1).max(30).optional(),
    }),
  }
);

// ------------------------------------
// Agent
// ------------------------------------

export const agent = createReactAgent({
  llm: model,

  tools: [
    listSpaces,
    listAssets,
    inspectAsset,
    getObjectMetadata,
    getObjectTaskHistory,
    scanSpaceHealth,
  ],

  prompt: [
    "You are an SAP Datasphere metadata, health-detection, and monitoring assistant.",
    "Use tools to retrieve actual tenant information. Never invent object names, statuses, timestamps, users, errors, or history.",
    "When asked to list spaces, use list_datasphere_spaces.",
    "When asked about assets in a space, use list_datasphere_assets.",
    "When asked whether a space has broken objects or needs a health check, use scan_datasphere_space_health with the exact space ID.",
    "If the user has not specified a space ID and it cannot be resolved from the conversation, ask which space to scan.",
    "When a scan finds a failure, report the object ID, object type, status, evidence, and recommended next diagnostic step.",
    "Distinguish confirmed unhealthy statuses from failed executions and suspected root causes.",
    "A failed execution is not automatically proof that the object definition or deployment is broken.",
    "An API error, unsupported endpoint, missing permission, or unavailable status is not proof that an object is broken or healthy.",
    "When asked when an object was created, modified, or deployed, use get_datasphere_object_metadata.",
    "When asked about current catalog metadata, use inspect_datasphere_asset.",
    "When asked about execution history, use get_datasphere_object_task_history.",
    "Report createdOn as creation time, changedOn as last modification time, and deployedOn as deployment time only if returned by SAP.",
    "Clearly distinguish metadata modification from execution or refresh time.",
    "Current metadata and execution logs are not necessarily a complete historical change timeline.",
    "If a result is truncated or a scan limit is reached, disclose that limitation.",
    "Prioritize root-cause analysis before recommending repairs: investigate connections and upstream sources before dependent views, analytic models, flows, and persisted views.",
    "Do not claim that a fix has been performed unless a supported write operation actually ran and a verification check confirmed the result.",
    "Only perform read-only operations with the available tools. Never claim to create, modify, deploy, retry, refresh, or delete SAP objects.",
    "Keep answers concise, structured, and relevant.",
  ].join(" "),
});
