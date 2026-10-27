
"use client";

import { useCallback, useEffect, useState } from "react";

export default function DataspherePage() {
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [tokenUrl, setTokenUrl] = useState("");

  const [connected, setConnected] = useState(false);
  const [tenantUrl, setTenantUrl] = useState("");
  const [status, setStatus] = useState("");

  const [spaces, setSpaces] = useState([]);
  const [selectedSpaceId, setSelectedSpaceId] = useState("");

  const [messages, setMessages] = useState([
    {
      role: "assistant",
      content:
        "Connect SAP Datasphere, select a space, and scan for unhealthy object statuses or failed executions. Findings are based on the evidence available through your SAP APIs.",
    },
  ]);

  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [connecting, setConnecting] = useState(false);

  const selectedSpace = spaces.find((space, index) => {
    const id =
      space.id || space.spaceId || space.name || `space-${index}`;
    return id === selectedSpaceId;
  });

  const getSpaceId = (space, index) =>
    space.id || space.spaceId || space.name || `space-${index}`;

  const getSpaceLabel = (space, index) =>
    space.name || space.label || getSpaceId(space, index);

  const loadSpaces = useCallback(async () => {
    try {
      const response = await fetch("/api/spaces", {
        cache: "no-store",
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || "Could not load spaces.");
      }

      const items = Array.isArray(data.value)
        ? data.value
        : Array.isArray(data.spaces)
          ? data.spaces
          : [];

      setSpaces(items);

      setSelectedSpaceId((current) => {
        if (
          current &&
          items.some(
            (space, index) => getSpaceId(space, index) === current
          )
        ) {
          return current;
        }

        return items.length ? getSpaceId(items[0], 0) : "";
      });

      return items;
    } catch (error) {
      setStatus(error.message || "Could not load spaces.");
      return [];
    }
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function restoreConnection() {
      try {
        const response = await fetch("/api/connections", {
          cache: "no-store",
        });

        const data = await response.json();

        if (cancelled) return;

        if (data.connected) {
          setConnected(true);
          setTenantUrl(data.tenantUrl || "");
          setStatus("Connected to SAP Datasphere.");

          const responseSpaces = await fetch("/api/spaces", {
            cache: "no-store",
          });

          const spacesData = await responseSpaces.json();

          if (!responseSpaces.ok) {
            throw new Error(
              spacesData.error || "Could not load spaces."
            );
          }

          const items = Array.isArray(spacesData.value)
            ? spacesData.value
            : Array.isArray(spacesData.spaces)
              ? spacesData.spaces
              : [];

          if (!cancelled) {
            setSpaces(items);
            setSelectedSpaceId(
              items.length ? getSpaceId(items[0], 0) : ""
            );
          }
        }
      } catch (error) {
        if (!cancelled) {
          setStatus(error.message || "Could not restore connection.");
        }
      }
    }

    restoreConnection();

    return () => {
      cancelled = true;
    };
  }, []);

  async function connect(event) {
    event.preventDefault();
    setConnecting(true);
    setStatus("");

    try {
      const response = await fetch("/api/connections", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientId, clientSecret, tokenUrl }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || "Connection failed.");
      }

      setConnected(true);
      setTenantUrl(data.tenantUrl || "");
      setClientSecret("");
      setStatus(data.message || "Connected.");

      setMessages((old) => [
        ...old,
        {
          role: "assistant",
          content: `Connected to ${data.tenantUrl}. Select a space to inspect assets or scan its health.`,
        },
      ]);

      await loadSpaces();
    } catch (error) {
      setConnected(false);
      setStatus(error.message || "Connection failed.");
    } finally {
      setConnecting(false);
    }
  }

  async function disconnect() {
    try {
      const response = await fetch("/api/connections", {
        method: "DELETE",
      });

      if (!response.ok) {
        throw new Error("Could not disconnect.");
      }

      setConnected(false);
      setTenantUrl("");
      setSpaces([]);
      setSelectedSpaceId("");
      setClientSecret("");
      setStatus("Disconnected.");
    } catch (error) {
      setStatus(error.message || "Disconnect failed.");
    }
  }

  async function sendMessage(text) {
    const message = text.trim();

    if (!message || loading) return;

    if (!connected) {
      setStatus("Connect to SAP Datasphere first.");
      return;
    }

    const history = messages.map(({ role, content }) => ({
      role,
      content,
    }));

    setInput("");
    setMessages((old) => [
      ...old,
      { role: "user", content: message },
    ]);
    setLoading(true);

    try {
      const response = await fetch("/api/agent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message, history }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || "Agent request failed.");
      }

      setMessages((old) => [
        ...old,
        {
          role: "assistant",
          content: data.answer || "No response returned.",
        },
      ]);
    } catch (error) {
      setMessages((old) => [
        ...old,
        {
          role: "assistant",
          content: `Error: ${error.message || "Request failed."}`,
        },
      ]);
    } finally {
      setLoading(false);
    }
  }

  function scanSelectedSpace() {
    if (!selectedSpaceId) {
      setStatus("Select a Datasphere space first.");
      return;
    }

    void sendMessage(
      `Scan SAP Datasphere space "${selectedSpaceId}" for broken objects. Check catalog statuses and task execution history. For each finding, show the object ID, object type, observed status, evidence, possible root cause, recommended next step, and any checks that could not be completed. Clearly state the scan limitations. Do not modify or repair anything.`
    );
  }

  function inspectSelectedSpace() {
    if (!selectedSpaceId) {
      setStatus("Select a Datasphere space first.");
      return;
    }

    void sendMessage(
      `List the assets available in SAP Datasphere space "${selectedSpaceId}".`
    );
  }

  function askAboutSelectedSpace(question) {
    if (!selectedSpaceId) {
      setStatus("Select a Datasphere space first.");
      return;
    }

    void sendMessage(
      `For SAP Datasphere space "${selectedSpaceId}": ${question}`
    );
  }

  return (
    <main className="flex min-h-screen flex-col bg-[#F4F7F9] text-[#32363A] lg:flex-row">
      <section className="min-w-0 flex-1 border-r border-[#D9D9D9] p-5 md:p-8">
        <header className="mb-6 flex items-center gap-3">
          <div className="rounded-lg bg-[#0070F2] px-3 py-2 font-black text-white">
            SAP
          </div>

          <div>
            <h1 className="text-xl font-bold">Datasphere Agent</h1>
            <p className="text-sm text-gray-500">
              OAuth · LangGraph · Groq · Object Health
            </p>
          </div>
        </header>

        {/* Connection */}
        <div className="mb-6 rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
          <h2 className="mb-1 text-lg font-bold">
            Connect to SAP Datasphere
          </h2>

          <p className="mb-4 text-sm text-gray-500">
            Enter the credentials from your SAP OAuth client.
          </p>

          <form onSubmit={connect} className="space-y-3">
            <label className="block text-sm font-semibold">
              Client ID
              <input
                required
                value={clientId}
                onChange={(event) => setClientId(event.target.value)}
                autoComplete="off"
                placeholder="SAP OAuth client ID"
                className="mt-1 w-full rounded-lg border p-3 font-normal outline-none focus:border-blue-500"
              />
            </label>

            <label className="block text-sm font-semibold">
              Client Secret
              <input
                required
                type="password"
                value={clientSecret}
                onChange={(event) =>
                  setClientSecret(event.target.value)
                }
                autoComplete="new-password"
                placeholder="SAP OAuth client secret"
                className="mt-1 w-full rounded-lg border p-3 font-normal outline-none focus:border-blue-500"
              />
            </label>

            <label className="block text-sm font-semibold">
              Token URL
              <input
                required
                type="url"
                value={tokenUrl}
                onChange={(event) => setTokenUrl(event.target.value)}
                placeholder="https://.../oauth/token"
                className="mt-1 w-full rounded-lg border p-3 font-normal outline-none focus:border-blue-500"
              />
            </label>

            <div className="flex flex-wrap gap-2 pt-1">
              <button
                type="submit"
                disabled={connecting}
                className="rounded-lg bg-[#0070F2] px-4 py-2.5 font-bold text-white disabled:opacity-60"
              >
                {connecting
                  ? "Connecting..."
                  : "Connect & Load Spaces"}
              </button>

              {connected && (
                <button
                  type="button"
                  onClick={disconnect}
                  className="rounded-lg border px-4 py-2.5 font-semibold"
                >
                  Disconnect
                </button>
              )}
            </div>
          </form>

          {status && (
            <p
              role="status"
              className="mt-3 break-words rounded-lg bg-gray-50 p-3 text-sm"
            >
              {status}
            </p>
          )}

          {connected && (
            <p className="mt-2 break-all text-xs text-gray-500">
              Tenant: {tenantUrl}
            </p>
          )}
        </div>

        {/* Space selection and health scan */}
        <div className="mb-6 rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
          <div className="mb-4">
            <h2 className="text-lg font-bold">Space Health Center</h2>
            <p className="mt-1 text-sm text-gray-500">
              Select a space to scan catalog statuses and execution history.
            </p>
          </div>

          <label className="block text-sm font-semibold">
            Select Datasphere space
            <select
              value={selectedSpaceId}
              onChange={(event) =>
                setSelectedSpaceId(event.target.value)
              }
              disabled={!connected || spaces.length === 0 || loading}
              className="mt-2 w-full rounded-lg border bg-white p-3 font-normal outline-none focus:border-blue-500 disabled:bg-gray-100"
            >
              <option value="">
                {connected
                  ? "Choose a space..."
                  : "Connect first"}
              </option>

              {spaces.map((space, index) => {
                const id = getSpaceId(space, index);

                return (
                  <option key={id} value={id}>
                    {getSpaceLabel(space, index)} ({id})
                  </option>
                );
              })}
            </select>
          </label>

          {selectedSpace && (
            <div className="mt-3 rounded-lg bg-gray-50 p-3 text-sm">
              <p className="font-semibold">
                {getSpaceLabel(
                  selectedSpace,
                  spaces.indexOf(selectedSpace)
                )}
              </p>
              <p className="mt-1 break-all text-xs text-gray-500">
                Space ID: {selectedSpaceId}
              </p>
              {selectedSpace.description && (
                <p className="mt-2 text-gray-600">
                  {selectedSpace.description}
                </p>
              )}
            </div>
          )}

          <div className="mt-4 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={scanSelectedSpace}
              disabled={!connected || !selectedSpaceId || loading}
              className="rounded-lg bg-[#0070F2] px-4 py-2.5 font-bold text-white disabled:cursor-not-allowed disabled:opacity-40"
            >
              {loading ? "Working..." : "Scan for Broken Objects"}
            </button>

            <button
              type="button"
              onClick={inspectSelectedSpace}
              disabled={!connected || !selectedSpaceId || loading}
              className="rounded-lg border px-4 py-2.5 font-semibold disabled:cursor-not-allowed disabled:opacity-40"
            >
              Inspect Assets
            </button>

            <button
              type="button"
              onClick={() => void loadSpaces()}
              disabled={!connected || loading}
              className="rounded-lg border px-4 py-2.5 font-semibold disabled:cursor-not-allowed disabled:opacity-40"
            >
              Refresh Spaces
            </button>
          </div>

          <p className="mt-3 text-xs leading-relaxed text-gray-500">
            The current scan is read-only. It reports findings supported
            by available APIs; it does not deploy, retry, refresh, or repair
            SAP objects.
          </p>
        </div>

        {/* Space list */}
        <div className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
          <div className="mb-4">
            <h2 className="text-lg font-bold">Accessible Spaces</h2>
            <p className="text-sm text-gray-500">
              Spaces returned by the Consumption Catalog API.
            </p>
          </div>

          {!connected ? (
            <p className="text-sm text-gray-500">
              Connect to view spaces.
            </p>
          ) : spaces.length === 0 ? (
            <p className="text-sm text-gray-500">
              No spaces returned. Check permissions or refresh.
            </p>
          ) : (
            <div className="space-y-3">
              {spaces.map((space, index) => {
                const id = getSpaceId(space, index);
                const isSelected = id === selectedSpaceId;

                return (
                  <div
                    key={id}
                    className={`rounded-xl border p-4 ${
                      isSelected
                        ? "border-blue-400 bg-blue-50/50"
                        : "border-gray-200"
                    }`}
                  >
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <p className="break-words font-bold">
                        {getSpaceLabel(space, index)}
                      </p>

                      {isSelected && (
                        <span className="rounded-full bg-blue-100 px-2 py-1 text-xs font-semibold text-blue-700">
                          Selected
                        </span>
                      )}
                    </div>

                    <p className="mt-1 break-all text-xs text-gray-500">
                      ID: {id}
                    </p>

                    {space.description && (
                      <p className="mt-2 text-sm text-gray-600">
                        {space.description}
                      </p>
                    )}

                    <div className="mt-3 flex flex-wrap gap-2">
                      <button
                        type="button"
                        onClick={() => setSelectedSpaceId(id)}
                        disabled={loading}
                        className="rounded-lg border px-3 py-2 text-sm font-semibold disabled:opacity-40"
                      >
                        Select Space
                      </button>

                      <button
                        type="button"
                        onClick={() => {
                          setSelectedSpaceId(id);
                          void sendMessage(
                            `Scan SAP Datasphere space "${id}" for broken objects. Check catalog statuses and task execution history, explain the evidence and limitations, and do not modify anything.`
                          );
                        }}
                        disabled={!connected || loading}
                        className="rounded-lg bg-blue-50 px-3 py-2 text-sm font-semibold text-blue-700 hover:bg-blue-100 disabled:opacity-40"
                      >
                        Scan This Space
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </section>

      {/* Chat panel */}
      <section className="flex min-h-[600px] w-full flex-col bg-white lg:sticky lg:top-0 lg:h-screen lg:w-[460px] lg:shrink-0">
        <header className="border-b p-5">
          <h2 className="font-bold">Ask your Datasphere Agent</h2>
          <p className="mt-1 text-xs text-gray-500">
            Ask about object health, metadata, execution failures, and
            potential root causes.
          </p>
        </header>

        <div className="flex-1 space-y-4 overflow-y-auto bg-gray-50 p-4">
          {messages.map((item, index) => (
            <div
              key={`${item.role}-${index}`}
              className={`flex ${
                item.role === "user" ? "justify-end" : "justify-start"
              }`}
            >
              <div
                className={`max-w-[95%] whitespace-pre-wrap break-words rounded-2xl px-4 py-3 text-sm leading-relaxed ${
                  item.role === "user"
                    ? "bg-[#0070F2] text-white"
                    : "border bg-white text-gray-800"
                }`}
              >
                {item.content}
              </div>
            </div>
          ))}

          {loading && (
            <p className="text-sm text-gray-500">
              Agent is checking SAP Datasphere...
            </p>
          )}
        </div>

        <div className="border-t bg-white p-3">
          <p className="mb-2 text-xs text-gray-500">
            {selectedSpaceId
              ? `Current space: ${selectedSpaceId}`
              : "Select a space to use the scan shortcuts."}
          </p>

          <div className="mb-3 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() =>
                askAboutSelectedSpace(
                  "show me the objects that have failed execution history and explain the available evidence"
                )
              }
              disabled={!connected || !selectedSpaceId || loading}
              className="rounded-full border px-3 py-1.5 text-xs font-semibold disabled:opacity-40"
            >
              Failed executions
            </button>

            <button
              type="button"
              onClick={() =>
                askAboutSelectedSpace(
                  "inspect the metadata for an object that I name next"
                )
              }
              disabled={!connected || !selectedSpaceId || loading}
              className="rounded-full border px-3 py-1.5 text-xs font-semibold disabled:opacity-40"
            >
              Object metadata
            </button>
          </div>

          <form
            onSubmit={(event) => {
              event.preventDefault();
              void sendMessage(input);
            }}
            className="flex items-end gap-2"
          >
            <textarea
              value={input}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={(event) => {
                if (
                  event.key === "Enter" &&
                  !event.shiftKey &&
                  !event.nativeEvent.isComposing
                ) {
                  event.preventDefault();
                  void sendMessage(input);
                }
              }}
              rows={2}
              maxLength={2000}
              placeholder="Ask about a selected space..."
              className="min-w-0 flex-1 resize-y rounded-xl border p-3 text-sm outline-none focus:border-blue-500"
            />

            <button
              type="submit"
              disabled={loading || !connected || !input.trim()}
              className="rounded-xl bg-[#0070F2] px-4 py-3 font-bold text-white disabled:cursor-not-allowed disabled:opacity-40"
            >
              Send
            </button>
          </form>
        </div>
      </section>
    </main>
  );
}
