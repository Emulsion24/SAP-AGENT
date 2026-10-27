
import { NextResponse } from "next/server";
import {
  deriveTenantUrl,
  encryptConnection,
  getAccessToken,
  datasphereGet,
  readConnectionCookie,
} from "@/lib/sap-datasphere";



const COOKIE_NAME = "ds_agent_connection";
const COOKIE_MAX_AGE = 60 * 60 * 8;

function getUpstreamStatus(error) {
  const message = String(error?.message || "");
  const match = message.match(/Datasphere API error (\d{3})/);
  return match ? Number(match[1]) : null;
}

function getErrorResponse(error, stage) {
  const message =
    error instanceof Error
      ? error.message
      : "An unexpected connection error occurred.";

  const upstreamStatus = getUpstreamStatus(error);

  // An upstream SAP error should not be reported as a client-side 400.
  const status = upstreamStatus
    ? 502
    : stage === "validation"
      ? 400
      : 502;

  return NextResponse.json(
    {
      connected: false,
      stage,
      error: message,
      ...(upstreamStatus ? { upstreamStatus } : {}),
    },
    { status }
  );
}

export async function GET(request) {
  const connection = readConnectionCookie(request);

  return NextResponse.json(
    connection
      ? {
          connected: true,
          tenantUrl: connection.tenantUrl,
        }
      : { connected: false }
  );
}

export async function POST(request) {
  let body;

  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      {
        connected: false,
        stage: "validation",
        error: "Request body must be valid JSON.",
      },
      { status: 400 }
    );
  }

  const clientId = String(body?.clientId || "").trim();
  const clientSecret = String(body?.clientSecret || "");
  const tokenUrl = String(body?.tokenUrl || "").trim();

  if (!clientId || !clientSecret || !tokenUrl) {
    return NextResponse.json(
      {
        connected: false,
        stage: "validation",
        error: "Client ID, client secret, and token URL are required.",
      },
      { status: 400 }
    );
  }

  let connection;

  // Stage 1: Validate and derive the tenant URL.
  try {
    const tenantUrl = deriveTenantUrl(tokenUrl);

    connection = {
      clientId,
      clientSecret,
      tokenUrl,
      tenantUrl,
    };
  } catch (error) {
    console.error("Datasphere configuration validation failed:", {
      message: error?.message,
    });

    return getErrorResponse(error, "configuration");
  }

  // Log hostnames only. Never log credentials or access tokens.
  console.info("Testing SAP Datasphere connection:", {
    tenantUrl: connection.tenantUrl,
    tokenHost: new URL(connection.tokenUrl).hostname,
    tokenPath: new URL(connection.tokenUrl).pathname,
  });

  // Stage 2: Verify OAuth independently.
  try {
    await getAccessToken(connection);
  } catch (error) {
    console.error("SAP OAuth authentication failed:", {
      message: error?.message,
    });

    return getErrorResponse(error, "oauth");
  }

  // Stage 3: Verify that the token can access the Datasphere catalog.
  let catalog;

  try {
    catalog = await datasphereGet(
      connection,
      "/api/v1/datasphere/consumption/catalog/spaces"
    );
  } catch (error) {
    const upstreamStatus = getUpstreamStatus(error);

    console.error("SAP Datasphere catalog access failed:", {
      tenantUrl: connection.tenantUrl,
      upstreamStatus,
      message: error?.message,
    });

    return getErrorResponse(error, "catalog_access");
  }

  // Save the connection only after OAuth and catalog access both succeed.
  try {
    const response = NextResponse.json({
      connected: true,
      tenantUrl: connection.tenantUrl,
      message: "OAuth and Datasphere catalog access succeeded.",
      spaces: catalog,
    });

    response.cookies.set(
      COOKIE_NAME,
      encryptConnection({
        ...connection,
        connectedAt: new Date().toISOString(),
      }),
      {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "strict",
        path: "/",
        maxAge: COOKIE_MAX_AGE,
      }
    );

    return response;
  } catch (error) {
    console.error("Failed to save Datasphere connection:", {
      message: error?.message,
    });

    return getErrorResponse(error, "connection_storage");
  }
}

export async function DELETE() {
  const response = NextResponse.json({ connected: false });

  response.cookies.set(COOKIE_NAME, "", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    path: "/",
    maxAge: 0,
  });

  return response;
}
