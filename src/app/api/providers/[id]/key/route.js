import { NextResponse } from "next/server";
import { getProviderConnectionById } from "@/models";

// GET /api/providers/[id]/key - Get the full API key for a connection
export async function GET(request, { params }) {
  try {
    const { id } = await params;
    const connection = await getProviderConnectionById(id);

    if (!connection) {
      return NextResponse.json({ error: "Connection not found" }, { status: 404 });
    }

    if (connection.authType === "oauth") {
      return NextResponse.json({ error: "OAuth connections do not have an API key" }, { status: 400 });
    }

    return NextResponse.json({ apiKey: connection.apiKey || "" });
  } catch (error) {
    console.log("Error fetching connection key:", error);
    return NextResponse.json({ error: "Failed to fetch connection key" }, { status: 500 });
  }
}
