import { XiaozhiConnection, type XiaozhiOptions } from "@voxengine/adapters/xiaozhi";
import { createEngine, type Engine, type EngineOptions } from "@voxengine/core";

export interface GatewayOptions extends EngineOptions {
  port?: number;
  hostname?: string;
  /** 小智设备走 `/chat`。 */
  xiaozhi?: XiaozhiOptions;
  /** 连接级日志（建连、断开、拒绝）。不传就不打。 */
  log?: (line: string) => void;
  /** 产品的 HTTP 路由：`/chat`、`/health` 和 `sockets` 之外的请求先给它，返回 undefined 时网关回 404。 */
  fetch?: (req: Request) => Response | undefined | Promise<Response | undefined>;
  /** 产品的 WebSocket 路由，按路径精确匹配，如 `/push`、`/sync`。 */
  sockets?: Record<string, SocketRoute>;
}

export interface Socket {
  readonly path: string;
  /** 升级请求的头，设备 id 等从这里取。 */
  readonly headers: Headers;
  send(data: string | Uint8Array): void;
  close(code?: number, reason?: string): void;
}

export interface SocketHandlers {
  message?(data: string | Uint8Array): void;
  close?(code: number, reason: string): void;
}

/** 每条连接建立时调一次，返回这条连接的处理函数。 */
export type SocketRoute = (socket: Socket) => SocketHandlers | void;

export interface Gateway {
  engine: Engine;
  port: number;
  stop(): Promise<void>;
}

type SocketData =
  | { kind: "chat"; connection?: XiaozhiConnection; deviceId: string; version: number }
  | { kind: "product"; path: string; headers: Headers; handlers?: SocketHandlers };

/** 起一个 HTTP + WebSocket 服务：`/chat` 接小智，`/health` 探活，其余交给产品的路由，都不认就 404。 */
export function startGateway(options: GatewayOptions): Gateway {
  const engine = createEngine(options);
  const log = options.log ?? (() => {});
  const sockets = options.sockets ?? {};
  const reject = (url: URL, status: number, body: string) => {
    log(`拒绝 ${url.pathname} ${status} ${body}`);
    return new Response(body, { status });
  };

  const server = Bun.serve<SocketData>({
    port: options.port ?? 8000,
    hostname: options.hostname,
    async fetch(req, server) {
      const url = new URL(req.url);
      if (url.pathname === "/health") return Response.json({ status: "ok" });
      if (url.pathname === "/chat") {
        const deviceId = req.headers.get("device-id");
        if (!deviceId) return reject(url, 400, "缺少 Device-Id 头");
        const version = Number(req.headers.get("protocol-version") ?? 1) || 1;
        if (server.upgrade(req, { data: { kind: "chat", deviceId, version } })) return undefined;
        return reject(url, 400, "WebSocket upgrade failed");
      }
      if (sockets[url.pathname]) {
        const data: SocketData = { kind: "product", path: url.pathname, headers: req.headers };
        if (server.upgrade(req, { data })) return undefined;
        return reject(url, 400, "WebSocket upgrade failed");
      }
      const response = await options.fetch?.(req);
      return response ?? reject(url, 404, "Not found");
    },
    websocket: {
      maxPayloadLength: 1024 * 1024,
      idleTimeout: 120,
      open(ws) {
        const data = ws.data;
        if (data.kind === "product") {
          const socket: Socket = {
            path: data.path,
            headers: data.headers,
            send: (payload) => void ws.send(payload),
            close: (code, reason) => ws.close(code, reason),
          };
          data.handlers = sockets[data.path]?.(socket) ?? undefined;
          return;
        }
        log(`/chat 建连 ${data.deviceId} v${data.version}`);
        data.connection = new XiaozhiConnection(
          engine,
          { send: (payload) => void ws.send(payload), close: () => ws.close() },
          { deviceId: data.deviceId, version: data.version },
          options.xiaozhi,
        );
      },
      message(ws, message) {
        const payload = typeof message === "string" ? message : new Uint8Array(message);
        const data = ws.data;
        if (data.kind === "product") data.handlers?.message?.(payload);
        else data.connection?.receive(payload);
      },
      close(ws, code, reason) {
        const data = ws.data;
        if (data.kind === "product") {
          data.handlers?.close?.(code, reason);
          return;
        }
        log(`/chat 断开 ${data.deviceId} ${code} ${reason}`);
        data.connection?.close();
      },
    },
  });

  return {
    engine,
    port: server.port ?? 0,
    async stop() {
      engine.close();
      await server.stop(true);
    },
  };
}
