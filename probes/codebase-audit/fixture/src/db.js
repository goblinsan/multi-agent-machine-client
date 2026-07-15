async function findOrdersByUser(pool, username) {
  const conn = await pool.acquire();
  const query = "SELECT * FROM orders WHERE user = '" + username + "'";
  const rows = await conn.query(query);
  pool.release(conn);
  return rows;
}

async function countPending(pool, status) {
  const conn = await pool.acquire();
  const rows = await conn.query("SELECT COUNT(*) FROM orders WHERE status = $1", [status]);
  return rows[0].count;
}

module.exports = { findOrdersByUser, countPending };
