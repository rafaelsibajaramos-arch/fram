import { createRequire } from 'node:module';
import path from 'node:path';

// Test dependencies must be reached over the actual protocol. RabbitMQ's
// Erlang CLI uses a separate cookie/nodename and is not an AMQP readiness test.
export async function probeAmqp(url, serviceDirectory, queue) {
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(url).hostname)) throw new Error('AMQP test probe is restricted to loopback');
  const amqp = createRequire(path.join(serviceDirectory, 'package.json'))('amqplib');
  let connection;
  try {
    connection = await amqp.connect(url, { timeout: 1500 });
    const channel = await connection.createChannel();
    const ready = queue ? (await channel.checkQueue(queue)).consumerCount > 0 : true;
    await channel.close();
    return ready;
  } finally { if (connection) await connection.close(); }
}
