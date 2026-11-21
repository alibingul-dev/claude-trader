// Azure Table Storage: every row stores its object as JSON in a single "json" column.
// Partitions: state | pos | trade | equity | decision | strategy
const { TableClient } = require('@azure/data-tables');

let client;
let ready;

function init() {
  if (!ready) {
    const conn = process.env.TABLE_CONN || process.env.AzureWebJobsStorage;
    if (!conn) throw new Error('TABLE_CONN / AzureWebJobsStorage tanımlı değil');
    client = TableClient.fromConnectionString(conn, process.env.TABLE_NAME || 'papertrade');
    ready = client.createTable().catch((e) => {
      if (e.statusCode !== 409) throw e;
    });
  }
  return ready;
}

const pack = (pk, rk, obj) => ({ partitionKey: pk, rowKey: rk, json: JSON.stringify(obj) });
const unpack = (e) => JSON.parse(e.json);

async function put(pk, rk, obj) {
  await init();
  await client.upsertEntity(pack(pk, rk, obj), 'Replace');
}

async function getOne(pk, rk) {
  await init();
  try {
    return unpack(await client.getEntity(pk, rk));
  } catch (e) {
    if (e.statusCode === 404) return null;
    throw e;
  }
}

async function del(pk, rk) {
  await init();
  try {
    await client.deleteEntity(pk, rk);
  } catch (e) {
    if (e.statusCode !== 404) throw e;
  }
}

async function list(pk) {
  await init();
  const out = [];
  const iter = client.listEntities({ queryOptions: { filter: `PartitionKey eq '${pk}'` } });
  for await (const e of iter) out.push(unpack(e));
  return out; // RowKey ascending
}

module.exports = { put, getOne, del, list };
