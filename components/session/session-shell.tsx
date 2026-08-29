"use client";

import { useEffect, useMemo, useState } from "react";

import { AdjustmentScreen } from "@/components/feedback/adjustment-screen";
import { SatisfactionScreen } from "@/components/feedback/satisfaction-screen";
import { IngredientConfirmationScreen } from "@/components/ingredients/ingredient-confirmation-screen";
import { MixingScreen } from "@/components/mixing/mixing-screen";
import { PreferencesScreen } from "@/components/preferences/preferences-screen";
import { RecipeSelectionScreen } from "@/components/recipes/recipe-selection-screen";
import { CameraScreen } from "@/components/scan/camera-screen";
import { MobileShell } from "@/components/session/fixed-action-bar";
import { ProgressHeader } from "@/components/session/progress-header";
import {
  SessionClient,
  SessionClientError,
  type AdjustmentStateSnapshot,
  type RecipeSetSnapshot,
  type SessionClientLike,
  type SessionSnapshot,
} from "@/src/infrastructure/http/session-client";

export interface SessionShellProps {
  sessionId: string;
  client?: SessionClientLike;
  initialSnapshot?: SessionSnapshot;
}

export function SessionShell(_props: SessionShellProps) {
  const { sessionId, initialSnapshot, client: providedClient } = _props;
  const client = useMemo(() => providedClient ?? new SessionClient(), [providedClient]);
  const [snapshot, setSnapshot] = useState<SessionSnapshot | null>(initialSnapshot ?? null);
  const [recipeSet, setRecipeSet] = useState<RecipeSetSnapshot["recipeSet"] | null>(null);
  const [adjustmentState, setAdjustmentState] = useState<AdjustmentStateSnapshot["data"] | null>(
    null,
  );
  const [satisfiedClosing, setSatisfiedClosing] = useState(false);
  const [isLoading, setIsLoading] = useState(initialSnapshot === undefined);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isGenerating, setIsGenerating] = useState(false);

  function handleReload() {
    window.location.reload();
  }

  useEffect(() => {
    let active = true;
    void client
      .getSession(sessionId)
      .then((nextSnapshot) => {
        if (!active) return;
        setSnapshot(nextSnapshot);
        setErrorMessage(null);
        const nextState = nextSnapshot.session.state;

        if (nextState === "RECIPE_SELECTION" || nextState === "MIXING") {
          return client.getRecipeSet(sessionId).then((recipeSnapshot) => {
            if (!active) return;
            setRecipeSet(recipeSnapshot.recipeSet);
            setSnapshot((current) =>
              current === null ? current : { ...current, session: recipeSnapshot.session },
            );
            if (nextState === "MIXING") {
              // V2+ 当前配方不在初始三卡批次中，需要从调整状态恢复。
              const inCurrentBatch = recipeSnapshot.recipeSet.recipes.some(
                (recipe) => recipe.id === nextSnapshot.data.selectedRecipeId,
              );
              if (!inCurrentBatch) {
                return client.getAdjustmentState(sessionId).then((adjustmentSnapshot) => {
                  if (!active) return;
                  setAdjustmentState(adjustmentSnapshot.data);
                  setSnapshot((current) =>
                    current === null
                      ? current
                      : { ...current, session: adjustmentSnapshot.session },
                  );
                });
              }
            }
            return undefined;
          });
        }

        if (nextState === "FEEDBACK" || nextState === "ADJUSTMENT") {
          return client.getAdjustmentState(sessionId).then((adjustmentSnapshot) => {
            if (!active) return;
            setAdjustmentState(adjustmentSnapshot.data);
            setSnapshot((current) =>
              current === null ? current : { ...current, session: adjustmentSnapshot.session },
            );
          });
        }

        return undefined;
      })
      .catch((error: unknown) => {
        if (!active) return;
        setErrorMessage(error instanceof Error ? error.message : "无法加载会话，请重试");
      })
      .finally(() => {
        if (active) setIsLoading(false);
      });

    return () => {
      active = false;
    };
  }, [client, initialSnapshot, sessionId]);

  async function runMutation<T>(mutation: () => Promise<T>): Promise<T> {
    try {
      return await mutation();
    } catch (error) {
      if (error instanceof SessionClientError && error.code === "VERSION_CONFLICT") {
        const latestSnapshot = await client.getSession(sessionId);
        setSnapshot(latestSnapshot);
        const latestState = latestSnapshot.session.state;
        if (latestState === "RECIPE_SELECTION" || latestState === "MIXING") {
          const latestRecipeSet = await client.getRecipeSet(sessionId);
          setRecipeSet(latestRecipeSet.recipeSet);
        }
        if (
          latestState === "FEEDBACK" ||
          latestState === "ADJUSTMENT" ||
          latestState === "MIXING"
        ) {
          const latestAdjustmentState = await client.getAdjustmentState(sessionId);
          setAdjustmentState(latestAdjustmentState.data);
        }
      }
      throw error;
    }
  }

  async function handleGenerateRecipeSet() {
    if (snapshot === null || isGenerating) return;

    setIsGenerating(true);
    setErrorMessage(null);
    try {
      const generated = await conflictAwareClient.generateRecipeSet({
        sessionId,
        expectedVersion: snapshot.session.version,
      });
      setSnapshot((current) =>
        current === null ? current : { ...current, session: generated.session },
      );
      const loaded = await conflictAwareClient.getRecipeSet(sessionId);
      setRecipeSet(loaded.recipeSet);
      setSnapshot((current) =>
        current === null ? current : { ...current, session: loaded.session },
      );
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "生成配方失败，请重试");
    } finally {
      setIsGenerating(false);
    }
  }

  const conflictAwareClient: SessionClientLike = {
    getSession: (id) => client.getSession(id),
    getRecipeSet: (id) => client.getRecipeSet(id),
    getAdjustmentState: (id) => client.getAdjustmentState(id),
    savePreferences: (input) => runMutation(() => client.savePreferences(input)),
    uploadOverviewImage: (input) => runMutation(() => client.uploadOverviewImage(input)),
    uploadMixingStepImage: (input) => runMutation(() => client.uploadMixingStepImage(input)),
    recognizeIngredients: (input) => runMutation(() => client.recognizeIngredients(input)),
    confirmIngredients: (input) => runMutation(() => client.confirmIngredients(input)),
    generateRecipeSet: (input) => runMutation(() => client.generateRecipeSet(input)),
    selectRecipe: (input) => runMutation(() => client.selectRecipe(input)),
    advanceMixing: (input) => runMutation(() => client.advanceMixing(input)),
    saveFeedback: (input) => runMutation(() => client.saveFeedback(input)),
    generateAdjustment: (input) => runMutation(() => client.generateAdjustment(input)),
    acceptAdjustment: (input) => runMutation(() => client.acceptAdjustment(input)),
  };

  if (isLoading || snapshot === null) {
    return (
      <MobileShell busy={isLoading}>
        <div className="mobile-shell__inner">
          <section className="mobile-surface session-recovery-card" aria-label="会话恢复">
            {errorMessage === null ? (
              <div className="session-loading">
                <p className="mobile-eyebrow">调饮实验</p>
                <p role="status" aria-live="polite">
                  正在恢复会话…
                </p>
              </div>
            ) : (
              <div className="session-loading">
                <div className="mobile-notice mobile-notice--error" role="alert">
                  <span className="mobile-notice__label">会话恢复失败</span>
                  <span>{errorMessage}</span>
                </div>
                <button
                  className="mobile-action mobile-action--primary w-full"
                  type="button"
                  onClick={handleReload}
                >
                  重新加载会话
                </button>
              </div>
            )}
          </section>
        </div>
      </MobileShell>
    );
  }

  return (
    <MobileShell busy={isGenerating}>
      <div className="mobile-shell__inner">
        <ProgressHeader state={snapshot.session.state} />
        {errorMessage !== null ? (
          <section className="mobile-notice mobile-notice--error space-y-3" role="alert">
            <div>
              <span className="mobile-notice__label">当前操作没有完成</span>
              <span>{errorMessage}</span>
            </div>
            <button
              className="mobile-action mobile-action--secondary w-full"
              type="button"
              onClick={handleReload}
            >
              重新加载会话
            </button>
          </section>
        ) : null}
        {snapshot.session.state === "PREFERENCES" ? (
          <PreferencesScreen
            initialPreferences={snapshot.data.preferences}
            expectedVersion={snapshot.session.version}
            onSubmit={(preferences, expectedVersion) =>
              conflictAwareClient.savePreferences({ sessionId, expectedVersion, preferences })
            }
            onSaved={setSnapshot}
          />
        ) : snapshot.session.state === "SCAN" ? (
          <CameraScreen
            sessionId={sessionId}
            expectedVersion={snapshot.session.version}
            client={conflictAwareClient}
            onRecognized={(result) => {
              setSnapshot((current) =>
                current === null
                  ? current
                  : {
                      ...current,
                      data: { ...current.data, ingredients: result.ingredients },
                      session: result.session,
                    },
              );
            }}
          />
        ) : snapshot.session.state === "CONFIRM" ? (
          <IngredientConfirmationScreen
            sessionId={sessionId}
            expectedVersion={snapshot.session.version}
            initialIngredients={snapshot.data.ingredients}
            client={conflictAwareClient}
            onConfirmed={(result) => {
              setSnapshot((current) =>
                current === null
                  ? current
                  : {
                      ...current,
                      data: { ...current.data, ingredients: result.ingredients },
                      session: result.session,
                    },
              );
            }}
          />
        ) : snapshot.session.state === "READY" ? (
          <section className="mobile-surface space-y-5 p-6">
            <div className="mobile-page-header">
              <p className="mobile-eyebrow">第四步 · 生成</p>
              <h1>生成三套配方</h1>
              <p>系统会基于已确认材料生成 A / B / C 三套方案。生成后你仍需主动比较和选择。</p>
            </div>
            <button
              type="button"
              className="mobile-action mobile-action--primary w-full"
              disabled={isGenerating}
              onClick={() => void handleGenerateRecipeSet()}
            >
              {isGenerating ? "正在生成配方…" : "生成三套配方"}
            </button>
          </section>
        ) : snapshot.session.state === "RECIPE_SELECTION" ? (
          recipeSet === null ? (
            <section role="status" aria-live="polite" className="mobile-surface p-6">
              正在恢复配方方案…
            </section>
          ) : (
            <RecipeSelectionScreen
              sessionId={sessionId}
              expectedVersion={snapshot.session.version}
              recipeSet={recipeSet}
              client={conflictAwareClient}
              onRegenerated={(result) => {
                setRecipeSet(result.recipeSet);
                setSnapshot((current) =>
                  current === null ? current : { ...current, session: result.session },
                );
              }}
              onSelected={(result) => {
                setSnapshot((current) =>
                  current === null
                    ? current
                    : {
                        ...current,
                        data: {
                          ...current.data,
                          selectedRecipeId: result.recipeId,
                          currentStep: result.currentStep,
                        },
                        session: result.session,
                      },
                );
              }}
            />
          )
        ) : snapshot.session.state === "MIXING" ? (
          (() => {
            const selectedRecipeId = snapshot.data.selectedRecipeId;
            const batchRecipe =
              recipeSet === null
                ? undefined
                : recipeSet.recipes.find((recipe) => recipe.id === selectedRecipeId);
            const adjustedModel =
              adjustmentState !== null &&
              adjustmentState.currentRecipe.recipeId === selectedRecipeId
                ? adjustmentState.currentRecipe
                : null;
            const recipe =
              batchRecipe ??
              (adjustedModel === null
                ? null
                : { ...adjustedModel.candidate, safety: adjustedModel.safety });

            if (recipe === null) {
              if (isLoading || (recipeSet !== null && adjustmentState === null)) {
                return (
                  <section role="status" aria-live="polite" className="mobile-surface p-6">
                    正在恢复调饮步骤…
                  </section>
                );
              }
              return (
                <section role="alert" className="mobile-notice mobile-notice--error">
                  当前选择的配方无法恢复，请重新加载服务端会话。
                </section>
              );
            }

            return (
              <MixingScreen
                key={`${recipe.id}:${snapshot.data.currentStep}`}
                sessionId={sessionId}
                expectedVersion={snapshot.session.version}
                currentStep={snapshot.data.currentStep}
                recipe={recipe}
                client={conflictAwareClient}
                onAdvanced={(result) => {
                  setSnapshot((current) =>
                    current === null
                      ? current
                      : {
                          ...current,
                          data: { ...current.data, currentStep: result.currentStep },
                          session: result.session,
                        },
                  );
                }}
              />
            );
          })()
        ) : snapshot.session.state === "FEEDBACK" ? (
          satisfiedClosing ? (
            <section className="mobile-surface p-6" aria-label="满意收尾">
              <div className="mobile-page-header">
                <p className="mobile-eyebrow">第六步 · 满意收尾</p>
                <h1>满意收尾</h1>
                <p>可选成品照拍摄与完成流程将在下一步接入。</p>
              </div>
            </section>
          ) : adjustmentState === null ? (
            <section role="status" aria-live="polite" className="mobile-surface p-6">
              正在恢复反馈状态…
            </section>
          ) : (
            <SatisfactionScreen
              sessionId={sessionId}
              expectedVersion={snapshot.session.version}
              currentRecipe={adjustmentState.currentRecipe}
              client={conflictAwareClient}
              onSatisfied={() => setSatisfiedClosing(true)}
              onFeedbackSaved={(result) => {
                setSnapshot((current) =>
                  current === null ? current : { ...current, session: result.session },
                );
                setAdjustmentState({
                  currentRecipe: adjustmentState.currentRecipe,
                  proposal: null,
                  pendingFeedbackId: result.feedbackId,
                });
              }}
            />
          )
        ) : snapshot.session.state === "ADJUSTMENT" ? (
          adjustmentState === null ? (
            <section role="status" aria-live="polite" className="mobile-surface p-6">
              正在恢复调整状态…
            </section>
          ) : (
            <AdjustmentScreen
              sessionId={sessionId}
              expectedVersion={snapshot.session.version}
              currentRecipe={adjustmentState.currentRecipe}
              proposal={adjustmentState.proposal}
              pendingFeedbackId={adjustmentState.pendingFeedbackId}
              client={conflictAwareClient}
              onAccepted={(result, proposal) => {
                setSnapshot((current) =>
                  current === null
                    ? current
                    : {
                        ...current,
                        data: {
                          ...current.data,
                          selectedRecipeId: proposal.recipeId,
                          currentStep: 0,
                        },
                        session: result.session,
                      },
                );
                setAdjustmentState((current) =>
                  current === null
                    ? current
                    : {
                        ...current,
                        currentRecipe: proposal,
                        proposal: null,
                        pendingFeedbackId: null,
                      },
                );
              }}
            />
          )
        ) : (
          <section className="mobile-surface p-6" role="status">
            <h1 className="text-2xl font-semibold">当前状态：{snapshot.session.state}</h1>
            <p className="mt-3 leading-7 text-stone-600">下一阶段界面将在后续任务接入。</p>
          </section>
        )}
      </div>
    </MobileShell>
  );
}
