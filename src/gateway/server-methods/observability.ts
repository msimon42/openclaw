import type { GatewayRequestHandlers } from "./types.js";
import {
  OBS_METHOD_PING,
  OBS_METHOD_SUBSCRIBE,
  OBS_METHOD_UNSUBSCRIBE,
  type ObsSubscribePayload,
} from "../../observability/stream-protocol.js";
import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  validateObsPingParams,
  validateObsSubscribeParams,
  validateObsUnsubscribeParams,
} from "../protocol/index.js";

function resolveConnId(client: { connId?: string } | null | undefined): string | null {
  const connId = typeof client?.connId === "string" ? client.connId.trim() : "";
  return connId || null;
}

function streamDisabledError() {
  return errorShape(ErrorCodes.UNAVAILABLE, "observability stream disabled");
}

export const observabilityHandlers: GatewayRequestHandlers = {
  [OBS_METHOD_SUBSCRIBE]: async ({ params, respond, context, client }) => {
    if (!validateObsSubscribeParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid ${OBS_METHOD_SUBSCRIBE} params: ${formatValidationErrors(validateObsSubscribeParams.errors)}`,
        ),
      );
      return;
    }
    const connId = resolveConnId(client);
    if (!connId) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "missing connection id"));
      return;
    }
    const stream = context.observabilityStream;
    if (!stream) {
      respond(false, undefined, streamDisabledError());
      return;
    }

    const subscribed = stream.subscribe(connId, params as ObsSubscribePayload);
    stream.sendInitial(connId, subscribed);
    respond(true, { subscribed: true }, undefined);
  },

  [OBS_METHOD_UNSUBSCRIBE]: async ({ params, respond, context, client }) => {
    if (!validateObsUnsubscribeParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid ${OBS_METHOD_UNSUBSCRIBE} params: ${formatValidationErrors(validateObsUnsubscribeParams.errors)}`,
        ),
      );
      return;
    }
    const connId = resolveConnId(client);
    if (!connId) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "missing connection id"));
      return;
    }
    const stream = context.observabilityStream;
    if (!stream) {
      respond(false, undefined, streamDisabledError());
      return;
    }
    stream.unsubscribe(connId);
    respond(true, { subscribed: false }, undefined);
  },

  [OBS_METHOD_PING]: async ({ params, respond, context, client }) => {
    if (!validateObsPingParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid ${OBS_METHOD_PING} params: ${formatValidationErrors(validateObsPingParams.errors)}`,
        ),
      );
      return;
    }
    const connId = resolveConnId(client);
    if (!connId) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "missing connection id"));
      return;
    }
    const stream = context.observabilityStream;
    if (!stream) {
      respond(false, undefined, streamDisabledError());
      return;
    }
    stream.ping(connId);
    respond(true, { pong: true }, undefined);
  },
};
