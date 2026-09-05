import type { Prisma, PrismaClient } from "./generated/prisma/client.js";

export type RepositoryClient = PrismaClient | Prisma.TransactionClient;
// Track the transaction supplied by our unit of work explicitly. Runtime
// client proxies can still expose $transaction; property presence does not
// establish whether starting another transaction is safe.
const boundClients = new WeakSet<object>();
export const bindTransactionClient = (
  client: Prisma.TransactionClient,
): Prisma.TransactionClient => {
  boundClients.add(client);
  return client;
};
export const isTransactionClient = (client: RepositoryClient): boolean =>
  boundClients.has(client);

export const withTransaction = <T>(
  client: RepositoryClient,
  operation: (transaction: Prisma.TransactionClient) => Promise<T>,
  options?: { isolationLevel?: Prisma.TransactionIsolationLevel },
): Promise<T> =>
  isTransactionClient(client)
    ? operation(client)
    : (client as PrismaClient).$transaction(operation, options);
