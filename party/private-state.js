/* 接続者ごとに異なる状態を安全に配信する汎用基盤。
   ──────────────────────────────────────────────────────────
   盤ゲームの公開stateにも、手札ゲームの秘匿stateにも使う。
   hiddenHandState() はサーバー権威の hands を直接公開オブジェクトへ混ぜず、
   seat token で本人性を確認できた接続にだけ privateView を合成する。

   後続カードゲームの基本契約:
     - seats: {token,...} | null の配列
     - hands: サーバーだけが保持する全手札の配列
     - publicState: 場・捨て札など、全接続へ公開してよい情報だけ
     - privateView: 本人だけへ追加する情報 (既定は {hand})
     - 観戦/未認証接続: youSeat=-1, hand=[] */

export function authenticatedSeat(conn, seats) {
  const cs = (conn && conn.state) || {};
  if (!Array.isArray(seats) || !Number.isInteger(cs.seat) || cs.seat < 0 || cs.seat >= seats.length) return -1;
  const seat = seats[cs.seat];
  return seat && cs.token && seat.token === cs.token ? cs.seat : -1;
}

export function hiddenHandState({
  conn,
  seats,
  hands,
  publicState,
  privateView = (_seat, hand) => ({ hand }),
}) {
  const safeHands = Array.isArray(hands) ? hands : [];
  const youSeat = authenticatedSeat(conn, seats);
  const hand = youSeat >= 0 && Array.isArray(safeHands[youSeat]) ? safeHands[youSeat] : [];
  return {
    type: 'state',
    ...(publicState || {}),
    youSeat,
    counts: safeHands.map(h => Array.isArray(h) ? h.length : 0),
    ...privateView(youSeat, hand),
  };
}

export function sendProjectedState(conn, project) {
  try { conn.send(JSON.stringify(project(conn))); } catch (e) {}
}

export function broadcastProjectedState(room, project) {
  for (const conn of room.getConnections()) sendProjectedState(conn, project);
}
