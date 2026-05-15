// 0.3 行为冒烟测试：验证默认聊天室成员制 + 动态 join + chat_send 默认目标
// 用法：node scripts/smoke-test.js
// 自带：起一个独立 SQLite + 独立端口的 server，跑完关掉
'use strict';

process.env.LOG_TO_STDERR = 'true';
process.env.SQLITE_PATH = require('path').join(__dirname, '..', 'data', 'smoke.db');
process.env.UPLOAD_DIR = require('path').join(__dirname, '..', 'data', 'smoke_uploads');
process.env.PORT = '17601';
process.env.BIND_HOST = '127.0.0.1';
process.env.WEB_SESSION_SECRET = 'smoke-test-secret';
process.env.WEB_USERNAME = 'admin';
process.env.WEB_PASSWORD = 'smoke';
process.env.CHAT_SERVER_URL = 'http://127.0.0.1:17601';

// 清理旧的 smoke DB（保证幂等）
const fs = require('fs');
const path = require('path');
for (const f of ['smoke.db', 'smoke.db-wal', 'smoke.db-shm']) {
  const p = path.join(__dirname, '..', 'data', f);
  try { fs.unlinkSync(p); } catch { /* ignore */ }
}

const WebSocket = require('ws');
const { MSG, ROLE, GLOBAL_TOPIC } = require('../shared/protocol');

let passed = 0;
let failed = 0;

function assert(cond, msg) {
  if (cond) { passed += 1; console.log('  PASS', msg); }
  else { failed += 1; console.log('  FAIL', msg); }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// 一个简化的 WS 客户端：能 hello、发 SEND、做几个 RPC、收 receiver 广播
class TestClient {
  constructor(name, role) {
    this.name = name;
    this.role = role;
    this.peer = { id: `smoke:${name}`, hostname: 'smoke', projectDir: `/tmp/${name}`, label: name };
    this.url = 'ws://127.0.0.1:17601';
    this.ws = null;
    this.received = []; // 收到的 MESSAGE 广播
    this.helloAck = null;
    this.rpc = new Map();
  }
  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.url);
      this.ws.on('open', () => {
        this.ws.send(JSON.stringify({ type: MSG.HELLO, role: this.role, peer: this.peer }));
      });
      this.ws.on('message', (raw) => {
        const m = JSON.parse(raw.toString());
        if (m.type === MSG.HELLO_ACK) { this.helloAck = m; resolve(); return; }
        if (m.type === MSG.MESSAGE) { this.received.push(m); return; }
        if (m.requestId && this.rpc.has(m.requestId)) {
          const { resolve: rr, reject: rj } = this.rpc.get(m.requestId);
          this.rpc.delete(m.requestId);
          if (m.type === MSG.ERROR) rj(new Error(m.error));
          else rr(m);
        }
      });
      this.ws.on('error', reject);
    });
  }
  rpcCall(type, payload = {}) {
    const requestId = Math.random().toString(36).slice(2);
    return new Promise((resolve, reject) => {
      this.rpc.set(requestId, { resolve, reject });
      this.ws.send(JSON.stringify({ type, requestId, ...payload }));
      setTimeout(() => {
        if (this.rpc.has(requestId)) {
          this.rpc.delete(requestId);
          reject(new Error(`RPC ${type} timeout`));
        }
      }, 3000);
    });
  }
  send(topic, body) {
    this.ws.send(JSON.stringify({ type: MSG.SEND, topic, body, attachments: [] }));
  }
  // 直接发 SEND，期望 server 回 ERROR（仅捕一个错误）
  sendExpectError(topic, body) {
    return new Promise((resolve) => {
      const onMessage = (raw) => {
        const m = JSON.parse(raw.toString());
        if (m.type === MSG.ERROR) {
          this.ws.off('message', onMessage);
          resolve(m.error);
        }
      };
      this.ws.on('message', onMessage);
      this.send(topic, body);
      setTimeout(() => { this.ws.off('message', onMessage); resolve(null); }, 800);
    });
  }
  close() { try { this.ws.close(); } catch {} }
}

async function main() {
  // 启动 server in-process
  console.log('启动测试 server...');
  require('../server/index.js');
  await sleep(500); // 等 listen

  // 客户端 A：A.sender + A.receiver（receiver 用来收消息）
  const A_send = new TestClient('alice', ROLE.SENDER);
  const A_recv = new TestClient('alice', ROLE.RECEIVER);
  const B_send = new TestClient('bob', ROLE.SENDER);
  const B_recv = new TestClient('bob', ROLE.RECEIVER);

  await Promise.all([A_send.connect(), A_recv.connect(), B_send.connect(), B_recv.connect()]);

  console.log('\n--- 用例 1：未 join 任何房间时发消息应被拒绝 ---');
  const err1 = await A_send.sendExpectError(GLOBAL_TOPIC, 'hi from alice');
  assert(err1 && err1.includes('未加入'), `未加入默认聊天室发送被拒：${err1}`);

  console.log('\n--- 用例 2：未 join 时收不到默认聊天室广播 ---');
  // 让 B 加入 global 并发一条（发送者自己被排除是正确行为，故不验证 B 自身收到）
  await B_send.rpcCall(MSG.TOPIC_JOIN, { slug: GLOBAL_TOPIC, createIfMissing: true });
  await sleep(100);
  A_recv.received = []; B_recv.received = [];
  B_send.send(GLOBAL_TOPIC, 'bob says hi in default room');
  await sleep(300);
  assert(A_recv.received.length === 0, 'A 未 join 默认聊天室，收不到 B 在那里的消息');

  console.log('\n--- 用例 3：join 自定义房间 + createIfMissing 自动创建 ---');
  const joinResp = await A_send.rpcCall(MSG.TOPIC_JOIN, {
    slug: 'feature:smoke', createIfMissing: true, title: 'smoke 测试房'
  });
  assert(joinResp && joinResp.topic && joinResp.topic.slug === 'feature:smoke',
    'A join 自定义房间成功（自动创建）');

  // B 也加入
  await B_send.rpcCall(MSG.TOPIC_JOIN, { slug: 'feature:smoke', createIfMissing: false });
  await sleep(100);

  A_recv.received = []; B_recv.received = [];
  B_send.send('feature:smoke', 'cross-room message');
  await sleep(300);
  assert(A_recv.received.find(m => m.body === 'cross-room message'),
    'A 已 join 自定义房间，能收到 B 的消息');

  console.log('\n--- 用例 4：leave 默认聊天室后不再收 global 消息 ---');
  // 现在 A 还没 join global，但我们 join 然后 leave 验证
  await A_send.rpcCall(MSG.TOPIC_JOIN, { slug: GLOBAL_TOPIC, createIfMissing: false });
  await sleep(100);
  A_recv.received = [];
  B_send.send(GLOBAL_TOPIC, 'after A joined global');
  await sleep(300);
  assert(A_recv.received.find(m => m.body === 'after A joined global'),
    'A join 默认聊天室后，能收到 global 消息');

  // 然后 leave
  await A_send.rpcCall(MSG.TOPIC_LEAVE, { slug: GLOBAL_TOPIC });
  await sleep(100);
  A_recv.received = [];
  B_send.send(GLOBAL_TOPIC, 'after A left global');
  await sleep(300);
  assert(A_recv.received.length === 0, 'A leave 默认聊天室后，不再收 global 消息（噪音屏蔽）');

  console.log('\n--- 用例 5：topic_member_joined 事件广播给房间成员 ---');
  // C 加入 feature:smoke，A/B 应该收到 topic_member_joined
  const C_send = new TestClient('carol', ROLE.SENDER);
  const C_recv = new TestClient('carol', ROLE.RECEIVER);
  await Promise.all([C_send.connect(), C_recv.connect()]);
  const eventsBefore = { a: A_recv.received.length, b: B_recv.received.length };
  // 监听 TOPIC_EVENT
  let aSawJoin = false, bSawJoin = false;
  const checkEvent = (client, flag) => {
    const oldOn = client.ws.listeners('message')[0];
    client.ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.type === MSG.TOPIC_EVENT && m.kind === 'topic_member_joined'
        && m.topic && m.topic.slug === 'feature:smoke' && m.peerId === 'smoke:carol') {
        flag.v = true;
      }
    });
  };
  const aFlag = { v: false }, bFlag = { v: false };
  checkEvent(A_recv, aFlag); checkEvent(B_recv, bFlag);
  await C_send.rpcCall(MSG.TOPIC_JOIN, { slug: 'feature:smoke', createIfMissing: false });
  await sleep(300);
  assert(aFlag.v, 'A 收到 carol 加入 feature:smoke 的事件');
  assert(bFlag.v, 'B 收到 carol 加入 feature:smoke 的事件');

  // 清理
  A_send.close(); A_recv.close(); B_send.close(); B_recv.close();
  C_send.close(); C_recv.close();
  await sleep(200);

  console.log(`\n=========================`);
  console.log(`通过 ${passed} / 失败 ${failed}`);
  console.log(`=========================`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(err => {
  console.error('冒烟测试异常:', err);
  process.exit(2);
});
