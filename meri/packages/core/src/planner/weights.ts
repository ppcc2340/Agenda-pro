/** Default scoring weights. Tune with tests; document any change in docs/04-planner-engine.md. */
export const DEFAULT_WEIGHTS = {
  priority: 3.0,
  deadlineUrgency: 4.0,
  costOfDelay: 2.0,
  unblocksOthers: 1.5,
  slackBonus: 0.5,
  hardDeadlineMultiplier: 2.0,
  movementPenalty: 2.5, // cost of moving an already accepted block (stability)
} as const;

export type Weights = typeof DEFAULT_WEIGHTS;
