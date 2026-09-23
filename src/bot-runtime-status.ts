export const betterOpenAIStatusKey = "better-openai";

/**
 * pi-better-openai includes the standalone word `fast` in its status segment
 * only while priority service is active for the selected model.
 */
export function fastModeFromBetterOpenAIStatus(text: string | undefined): boolean | null {
  if (text === undefined) return null;
  return /(?:^|\s)fast(?=\s|·|$)/u.test(text);
}
