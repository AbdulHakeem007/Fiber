import type { Prisma } from "@prisma/client";

type Tx = Prisma.TransactionClient;

type ChangeArgs = {
  operatorId?: string | null;
  actionType: "INSERT" | "UPDATE" | "DELETE";
  targetTable: string;
  targetId: string;
  originalState?: unknown;
  newState?: unknown;
  batchId?: string | null;
};

function jsonValue(value: unknown): Prisma.InputJsonValue | undefined {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

export async function logChange(tx: Tx, args: ChangeArgs) {
  return tx.systemChangeLog.create({
    data: {
      operatorId: args.operatorId ?? null,
      actionType: args.actionType,
      targetTable: args.targetTable,
      targetId: args.targetId,
      originalState: jsonValue(args.originalState),
      newState: jsonValue(args.newState),
      batchId: args.batchId ?? null,
    },
  });
}

export async function auditedUpdate(
  tx: Tx,
  model: { findUnique: Function; update: Function },
  tableName: string,
  id: string,
  data: Record<string, unknown>,
  operatorId?: string | null,
) {
  const before = await model.findUnique({ where: { id } });
  const after = await model.update({ where: { id }, data });
  await logChange(tx, {
    operatorId,
    actionType: "UPDATE",
    targetTable: tableName,
    targetId: id,
    originalState: before,
    newState: after,
  });
  return after;
}
