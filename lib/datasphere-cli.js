import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

const execFileAsync = promisify(execFile);

const OBJECT_TYPES = [
  "views",
  "local-tables",
  "remote-tables",
  "data-flows",
  "replication-flows",
  "transformation-flows",
  "task-chains",
  "analytic-models",
  "fact-models",
  "consumption-models",
  "data-access-controls",
  "er-models",
  "intelligent-lookups",
  "business-entities",
];

function validate(value, label) {
  const result = String(value || "").trim();

  if (!result || result.length > 200 || /[\u0000-\u001f]/.test(result)) {
    throw new Error(`Invalid ${label}.`);
  }

  return result;
}

async function runDatasphereCli(args, connection) {
  // The CLI supports options through environment variables.
  // Keep credentials out of command-line arguments.
  const env = {
    ...process.env,
    HOST: connection.tenantUrl,
    TOKEN_URL: connection.tokenUrl,
    CLIENT_ID: connection.clientId,
    CLIENT_SECRET: connection.clientSecret,
    AUTHORIZATION_FLOW: "client_credentials",
  };

  return execFileAsync(
    "npx",
    ["--no-install", "datasphere", ...args],
    {
      env,
      timeout: 60000,
      maxBuffer: 2 * 1024 * 1024,
    }
  );
}

export async function findObjectMetadata({
  connection,
  spaceId,
  objectName,
}) {
  const space = validate(spaceId, "space ID");
  const technicalName = validate(objectName, "object technical name");

  const tempDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "datasphere-metadata-")
  );

  try {
    // Authenticate using the existing OAuth connection.
    await runDatasphereCli(
      ["login", "--authorization-flow", "client_credentials"],
      connection
    );

    const matches = [];
    const errors = [];

    for (const type of OBJECT_TYPES) {
      const outputFile = path.join(
        tempDir,
        `${crypto.randomUUID()}.json`
      );

      try {
        await runDatasphereCli(
          [
            "objects",
            type,
            "list",
            "--space",
            space,
            "--technical-names",
            technicalName,
            "--select",
            "technicalName,businessName,type,semanticUsage,status,createdOn,changedOn,deployedOn,createdBy,changedBy",
            "--top",
            "10",
            "--output",
            outputFile,
          ],
          connection
        );

        const raw = await fs.readFile(outputFile, "utf8");
        const parsed = JSON.parse(raw);
        const rows = Array.isArray(parsed)
          ? parsed
          : Array.isArray(parsed.value)
            ? parsed.value
            : [];

        for (const item of rows) {
          if (
            item.technicalName?.toLowerCase() ===
            technicalName.toLowerCase()
          ) {
            matches.push({
              objectType: type,
              ...item,
            });
          }
        }
      } catch (error) {
        // Some types may be unsupported for this object or inaccessible.
        // Keep errors for diagnostics without exposing credentials.
        errors.push({
          objectType: type,
          message: String(error.message || "CLI query failed").slice(
            0,
            250
          ),
        });
      } finally {
        await fs.rm(outputFile, { force: true }).catch(() => {});
      }
    }

    if (matches.length === 0) {
      return {
        found: false,
        spaceId: space,
        objectName: technicalName,
        message:
          "No matching object metadata was found. Check the space ID, technical name, object permissions, and CLI authentication.",
        diagnostics: errors.slice(0, 4),
      };
    }

    return {
      found: true,
      spaceId: space,
      objectName: technicalName,
      metadata: matches,
    };
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}