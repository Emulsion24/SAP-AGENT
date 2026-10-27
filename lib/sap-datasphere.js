
import crypto from "node:crypto";

function getEncryptionKey() {
  const key = process.env.CONNECTION_ENCRYPTION_KEY;

  if (!key || !/^[a-fA-F0-9]{64}$/.test(key)) {
    throw new Error(
      "Set CONNECTION_ENCRYPTION_KEY to 64 hex characters. Generate it with: openssl rand -hex 32"
    );
  }

  return Buffer.from(key, "hex");
}

export function deriveTenantUrl(tokenUrlValue) {
  const tokenUrl = new URL(String(tokenUrlValue || ""));

  if (tokenUrl.protocol !== "https:") {
    throw new Error("The OAuth token URL must use HTTPS.");
  }

  if (!tokenUrl.pathname.endsWith("/oauth/token")) {
    throw new Error(
      "The token URL must end with /oauth/token. Verify the exact URL in SAP."
    );
  }

  if (process.env.SAP_TENANT_URL) {
    const configured = new URL(process.env.SAP_TENANT_URL);

    if (configured.protocol !== "https:") {
      throw new Error("SAP_TENANT_URL must use HTTPS.");
    }

    return configured.origin;
  }

  // Common SAP authentication hostname pattern.
  const match = tokenUrl.hostname.match(
    /^([a-zA-Z0-9-]+)\.authentication\.([a-zA-Z0-9-]+)\.hana\.ondemand\.com$/
  );

  if (!match) {
    throw new Error(
      "Could not infer the Datasphere tenant URL. Set SAP_TENANT_URL in .env.local to your actual tenant base URL."
    );
  }

  const [, tenant, region] = match;

  return `https://${tenant}.${region}.hcs.cloud.sap`;
}

export function encryptConnection(connection) {
  const iv = crypto.randomBytes(12);

  const cipher = crypto.createCipheriv(
    "aes-256-gcm",
    getEncryptionKey(),
    iv
  );

  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(connection), "utf8"),
    cipher.final(),
  ]);

  return Buffer.concat([
    iv,
    cipher.getAuthTag(),
    ciphertext,
  ]).toString("base64url");
}

function decryptConnection(value) {
  const packed = Buffer.from(value, "base64url");

  if (packed.length < 29) {
    throw new Error("Invalid connection cookie.");
  }

  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    getEncryptionKey(),
    packed.subarray(0, 12)
  );

  decipher.setAuthTag(packed.subarray(12, 28));

  const plaintext = Buffer.concat([
    decipher.update(packed.subarray(28)),
    decipher.final(),
  ]).toString("utf8");

  return JSON.parse(plaintext);
}

export function readConnectionCookie(request) {
  const value = request.cookies.get("ds_agent_connection")?.value;

  if (!value) return null;

  try {
    return decryptConnection(value);
  } catch {
    return null;
  }
}

export async function getAccessToken(connection) {
  const basic = Buffer.from(
    `${connection.clientId}:${connection.clientSecret}`
  ).toString("base64");

  const response = await fetch(connection.tokenUrl, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: new URLSearchParams({
      grant_type: "client_credentials",
    }),
    cache: "no-store",
    signal: AbortSignal.timeout(15000),
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok || !data.access_token) {
    throw new Error(
      `OAuth token request failed (${response.status}): ${
        data.error_description ||
        data.error ||
        "No access token returned."
      }`
    );
  }

  return data.access_token;
}

export async function datasphereGet(connection, path) {
  if (typeof path !== "string" || !path.startsWith("/")) {
    throw new Error("Invalid Datasphere API path.");
  }

  // Allow only the API areas used by this read-only agent.
  const allowedPrefixes = [
    "/api/v1/datasphere/consumption/",
    "/api/v1/datasphere/tasks/logs/",
  ];

  if (
    !allowedPrefixes.some((prefix) => path.startsWith(prefix)) ||
    path.includes("..") ||
    path.includes("\\") ||
    path.includes("#")
  ) {
    throw new Error("This Datasphere API GET path is not allowed.");
  }

  const token = await getAccessToken(connection);

  const response = await fetch(
    `${connection.tenantUrl}${path}`,
    {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      },
      cache: "no-store",
      signal: AbortSignal.timeout(20000),
    }
  );

  const body = await response.text();

  if (!response.ok) {
    throw new Error(
      `Datasphere API error ${response.status}: ${body.slice(0, 500)}`
    );
  }

  try {
    return JSON.parse(body);
  } catch {
    return body;
  }
}
