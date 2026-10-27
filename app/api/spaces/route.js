import { NextResponse } from "next/server";
import {
  datasphereGet,
  readConnectionCookie,
} from "@/lib/sap-datasphere";

export async function GET(request) {
  try {
    const connection = readConnectionCookie(request);

    if (!connection) {
      return NextResponse.json(
        { error: "Connect to SAP Datasphere first." },
        { status: 401 }
      );
    }

    const data = await datasphereGet(
      connection,
      "/api/v1/datasphere/consumption/catalog/spaces"
    );

    return NextResponse.json(data);
  } catch (error) {
    console.error("Failed to list Datasphere spaces:", error);

    return NextResponse.json(
      { error: error.message || "Unable to retrieve spaces." },
      { status: 500 }
    );
  }
}