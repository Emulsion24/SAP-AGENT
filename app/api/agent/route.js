import { NextResponse } from "next/server";
import { HumanMessage, AIMessage } from "@langchain/core/messages";
import { agent } from "@/lib/agent";
import { readConnectionCookie } from "@/lib/sap-datasphere";

export async function POST(request) {
  try {
    const connection = readConnectionCookie(request);

    if (!connection) {
      return NextResponse.json(
        { error: "Connect to SAP Datasphere first." },
        { status: 401 }
      );
    }

    const body = await request.json();
    const message = body.message;

    if (typeof message !== "string" || !message.trim()) {
      return NextResponse.json(
        { error: "A message is required." },
        { status: 400 }
      );
    }

    if (message.length > 2000) {
      return NextResponse.json(
        { error: "Please keep your message under 2,000 characters." },
        { status: 400 }
      );
    }

    const history = Array.isArray(body.history)
      ? body.history.slice(-4)
      : [];

    const messages = [];

    for (const item of history) {
      if (!item || typeof item.content !== "string") continue;

      const content = item.content.slice(0, 500);

      if (item.role === "user") {
        messages.push(new HumanMessage(content));
      } else if (item.role === "assistant") {
        messages.push(new AIMessage(content));
      }
    }

    messages.push(new HumanMessage(message.trim()));

    const result = await agent.invoke(
      { messages },
      {
        configurable: {
          datasphereConnection: connection,
        },
      }
    );

    const last = result.messages?.[result.messages.length - 1];
    let answer = last?.content;

    if (Array.isArray(answer)) {
      answer = answer
        .map((part) =>
          typeof part === "string" ? part : part?.text || ""
        )
        .join("\n");
    }

    if (typeof answer !== "string") {
      answer = JSON.stringify(answer ?? "No response returned.");
    }

    return NextResponse.json({ answer });
  } catch (error) {
    console.error("Agent route error:", error);

    const message = error?.message || "The agent request failed.";
    const isRateLimit =
      /rate_limit_exceeded|tokens per minute|request too large/i.test(
        message
      );

    return NextResponse.json(
      {
        error: isRateLimit
          ? "Groq's token limit was exceeded. Wait briefly and retry with a more specific question, such as asking about one space or asset."
          : message,
      },
      { status: isRateLimit ? 429 : 500 }
    );
  }
}