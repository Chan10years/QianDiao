import { z } from "zod";

import {
  CurrentRecipeNotFoundError,
  toVersionedRecipeReadModel,
  type VersionedRecipeReadModel,
} from "@/src/application/get-current-recipe";
import type { AdjustmentReadRepository } from "@/src/application/unit-of-work";
import { SessionIdSchema } from "@/src/domain/id";
import { RecipeDataIntegrityError } from "@/src/repositories/recipe-repository";
import { SessionNotFoundError } from "@/src/repositories/session-repository";

const GetAdjustmentStateInputSchema = z
  .object({
    sessionId: SessionIdSchema,
  })
  .strict();

export type GetAdjustmentStateInput = z.input<typeof GetAdjustmentStateInputSchema>;

export interface AdjustmentStateData {
  currentRecipe: VersionedRecipeReadModel;
  proposal: VersionedRecipeReadModel | null;
  pendingFeedbackId: string | null;
}

export type GetAdjustmentStateReadRepository = Pick<
  AdjustmentReadRepository,
  | "findSessionById"
  | "findRecipeById"
  | "listRecipesBySession"
  | "listSafetyDecisionsBySet"
  | "listFeedbackByRecipe"
>;

export interface GetAdjustmentStateDependencies {
  read(): GetAdjustmentStateReadRepository;
}

/**
 * 读取调整阶段的恢复状态：当前已接受配方（Vn）、待确认 proposal（Vn+1，最多一个）
 * 与未接受反馈的 pendingFeedbackId。
 *
 * Product Pivot Spec 要求 proposal 与 current recipe 分开读取；该只读用例不改任何
 * 13A/13B 写合同，仅服务刷新恢复与 MIXING(Vn>=2) 的当前配方展示。
 */
export function getAdjustmentState(
  dependencies: GetAdjustmentStateDependencies,
  input: GetAdjustmentStateInput,
): { data: AdjustmentStateData; session: { id: string; state: string; version: number } } {
  const parsed = GetAdjustmentStateInputSchema.parse(input);
  const repository = dependencies.read();

  const session = repository.findSessionById(parsed.sessionId);
  if (session === null) {
    throw new SessionNotFoundError();
  }
  if (session.selectedRecipeId === null) {
    throw new CurrentRecipeNotFoundError();
  }

  const currentRecord = repository.findRecipeById(session.selectedRecipeId);
  if (currentRecord === null || currentRecord.sessionId !== session.id) {
    throw new RecipeDataIntegrityError();
  }

  const currentRecipe = toVersionedRecipeReadModel(
    currentRecord,
    repository.listSafetyDecisionsBySet(currentRecord.recipeSetId),
    session.selectedRecipeId,
  );

  const proposals = repository
    .listRecipesBySession(parsed.sessionId)
    .filter(
      (recipe) =>
        recipe.parentRecipeId === currentRecord.id &&
        recipe.version === currentRecord.version + 1,
    );
  if (proposals.length > 1) {
    // 生成端保证同一 current recipe + version 至多一个 proposal；违反即数据完整性错误。
    throw new RecipeDataIntegrityError();
  }

  const proposalRecord = proposals[0] ?? null;
  const proposal =
    proposalRecord === null
      ? null
      : toVersionedRecipeReadModel(
          proposalRecord,
          repository.listSafetyDecisionsBySet(proposalRecord.recipeSetId),
          session.selectedRecipeId,
        );

  // 没有 proposal 时返回最近一条未接受反馈，供客户端恢复“保存反馈后、生成前”的中断。
  let pendingFeedbackId: string | null = null;
  if (proposal === null) {
    const lastFeedback = repository.listFeedbackByRecipe(currentRecord.id).at(-1);
    if (lastFeedback !== undefined && !lastFeedback.accepted) {
      pendingFeedbackId = lastFeedback.id;
    }
  }

  return {
    data: { currentRecipe, proposal, pendingFeedbackId },
    session: { id: session.id, state: session.state, version: session.version },
  };
}
