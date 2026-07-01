/* 五目並べ オンライン対戦 — Cloudflare Workers + Durable Objects エントリ (partyserver)
   ──────────────────────────────────────────────────────────
   マネージド partykit.dev に依存せず、自分の Cloudflare アカウントへ wrangler で
   直接デプロイする構成。ゲームロジックは ./server.js の GomokuServer をそのまま温存し、
   partyserver の Server でラップして委譲する (PartyKit互換のI/Fを this から合成)。

   接続パス互換: クライアントは従来どおり wss://<host>/parties/main/<code> に接続。
   wrangler.toml の DO バインディング名 "Main" が kebab 化されて party "main" に対応する。
   #11 オセロ: DOバインディング "Othello"(→party "othello") を相乗りで追加。
   クライアントは wss://<host>/parties/othello/<code> に接続する。ロジックは OthelloServer に委譲。 */
import { Server, routePartykitRequest } from 'partyserver';
import GomokuServer from './server.js';
import OthelloServer from './othello-server.js';

export class Gomoku extends Server {
  static options = { hibernate: true }; // WebSocket Hibernation (接続stateは setState で永続)

  constructor(ctx, env) {
    super(ctx, env);
    // GomokuServer が期待する PartyKit互換の room を this から合成
    const room = {
      storage: ctx.storage,                       // get/put/setAlarm/getAlarm/deleteAlarm を持つ DO storage
      getConnections: () => this.getConnections(),
      broadcast: (msg) => this.broadcast(msg),
    };
    this.logic = new GomokuServer(room);
  }
  // game 未ロードのまま入口に来ても安全なように (partyserver は通常 onStart 済みだが冪等保険)
  async ensure() { if (!this.logic.game) await this.logic.onStart(); }

  async onStart() { await this.logic.onStart(); }
  async onConnect(conn) { await this.ensure(); return this.logic.onConnect(conn); }
  async onMessage(conn, message) { await this.ensure(); return this.logic.onMessage(message, conn); } // 引数順を入替
  async onClose(conn) { await this.ensure(); return this.logic.onClose(conn); }
  onError() { return this.logic.onError(); }
  async onAlarm() { await this.ensure(); return this.logic.onAlarm(); }
}

// #11 オセロ: 五目と同じ partyserver ラッパで OthelloServer を委譲実行 (別DO=別部屋空間)
export class Othello extends Server {
  static options = { hibernate: true };

  constructor(ctx, env) {
    super(ctx, env);
    const room = {
      storage: ctx.storage,
      getConnections: () => this.getConnections(),
      broadcast: (msg) => this.broadcast(msg),
    };
    this.logic = new OthelloServer(room);
  }
  async ensure() { if (!this.logic.game) await this.logic.onStart(); }

  async onStart() { await this.logic.onStart(); }
  async onConnect(conn) { await this.ensure(); return this.logic.onConnect(conn); }
  async onMessage(conn, message) { await this.ensure(); return this.logic.onMessage(message, conn); }
  async onClose(conn) { await this.ensure(); return this.logic.onClose(conn); }
  onError() { return this.logic.onError(); }
  async onAlarm() { await this.ensure(); return this.logic.onAlarm(); }
}

export default {
  async fetch(request, env) {
    // /parties/main/<code>→Gomoku, /parties/othello/<code>→Othello へルーティング。それ以外は 404
    return (await routePartykitRequest(request, env)) || new Response('not found', { status: 404 });
  },
};
