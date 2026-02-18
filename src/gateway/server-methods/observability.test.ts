import { describe, expect, it, vi } from "vitest";
import {
  OBS_METHOD_PING,
  OBS_METHOD_SUBSCRIBE,
  OBS_METHOD_UNSUBSCRIBE,
  OBS_SCHEMA_VERSION,
} from "../../observability/stream-protocol.js";
import { observabilityHandlers } from "./observability.js";

function createContext() {
  const subscribe = vi.fn(() => ({
    snapshot: { schemaVersion: OBS_SCHEMA_VERSION, events: [] },
    health: { schemaVersion: OBS_SCHEMA_VERSION, updatedAt: Date.now(), models: [], fallbacks: [] },
    spend: {
      schemaVersion: OBS_SCHEMA_VERSION,
      updatedAt: Date.now(),
      totals: { calls: 0, tokensIn: 0, tokensOut: 0, costUsd: 0 },
      byModel: [],
      byAgent: [],
    },
  }));
  const unsubscribe = vi.fn();
  const ping = vi.fn();
  const sendInitial = vi.fn();

  return {
    context: {
      observabilityStream: {
        subscribe,
        unsubscribe,
        ping,
        sendInitial,
      },
      broadcastToConnIds: vi.fn(),
    },
    subscribe,
    unsubscribe,
    ping,
    sendInitial,
  };
}

const makeClient = (connId: string) =>
  ({
    connId,
    connect: { role: "operator", scopes: ["operator.admin"] },
  }) as never;

describe("observability ws handlers", () => {
  it("subscribe calls stream and returns success", async () => {
    const respond = vi.fn();
    const { context, subscribe, sendInitial } = createContext();

    await observabilityHandlers[OBS_METHOD_SUBSCRIBE]({
      req: { type: "req", id: "1", method: OBS_METHOD_SUBSCRIBE },
      params: {
        schemaVersion: OBS_SCHEMA_VERSION,
        filters: { agentId: "main", eventTypes: ["tool.call.blocked"] },
        maxEventsPerSec: 5,
      },
      client: makeClient("conn-1"),
      isWebchatConnect: () => false,
      respond,
      context: context as never,
    });

    expect(subscribe).toHaveBeenCalledWith(
      "conn-1",
      expect.objectContaining({ schemaVersion: OBS_SCHEMA_VERSION }),
    );
    expect(sendInitial).toHaveBeenCalledTimes(1);
    expect(respond).toHaveBeenCalledWith(true, { subscribed: true }, undefined);
  });

  it("unsubscribe stops stream for connection", async () => {
    const respond = vi.fn();
    const { context, unsubscribe } = createContext();

    await observabilityHandlers[OBS_METHOD_UNSUBSCRIBE]({
      req: { type: "req", id: "2", method: OBS_METHOD_UNSUBSCRIBE },
      params: { schemaVersion: OBS_SCHEMA_VERSION },
      client: makeClient("conn-2"),
      isWebchatConnect: () => false,
      respond,
      context: context as never,
    });

    expect(unsubscribe).toHaveBeenCalledWith("conn-2");
    expect(respond).toHaveBeenCalledWith(true, { subscribed: false }, undefined);
  });

  it("ping emits pong through stream", async () => {
    const respond = vi.fn();
    const { context, ping } = createContext();

    await observabilityHandlers[OBS_METHOD_PING]({
      req: { type: "req", id: "3", method: OBS_METHOD_PING },
      params: { schemaVersion: OBS_SCHEMA_VERSION },
      client: makeClient("conn-3"),
      isWebchatConnect: () => false,
      respond,
      context: context as never,
    });

    expect(ping).toHaveBeenCalledWith("conn-3");
    expect(respond).toHaveBeenCalledWith(true, { pong: true }, undefined);
  });

  it("returns validation error for invalid subscribe params", async () => {
    const respond = vi.fn();
    const { context, subscribe } = createContext();

    await observabilityHandlers[OBS_METHOD_SUBSCRIBE]({
      req: { type: "req", id: "4", method: OBS_METHOD_SUBSCRIBE },
      params: { schemaVersion: "0.9" },
      client: makeClient("conn-4"),
      isWebchatConnect: () => false,
      respond,
      context: context as never,
    });

    expect(subscribe).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "INVALID_REQUEST" }),
    );
  });

  it("returns unavailable when stream is disabled", async () => {
    const respond = vi.fn();

    await observabilityHandlers[OBS_METHOD_SUBSCRIBE]({
      req: { type: "req", id: "5", method: OBS_METHOD_SUBSCRIBE },
      params: { schemaVersion: OBS_SCHEMA_VERSION },
      client: makeClient("conn-5"),
      isWebchatConnect: () => false,
      respond,
      context: {
        observabilityStream: undefined,
      } as never,
    });

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "UNAVAILABLE" }),
    );
  });
});
