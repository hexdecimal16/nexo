import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import type { Prompter, QuestionAnswer, QuestionRequest } from "./policy.ts";

const OptionSchema = Type.Object({
	label: Type.String({ minLength: 1, maxLength: 80, description: "Short answer text the user picks (1-5 words)" }),
	description: Type.Optional(Type.String({ maxLength: 200, description: "What choosing this option means or implies" })),
});

const QuestionSchema = Type.Object({
	question: Type.String({ minLength: 1, maxLength: 500, description: "The complete question, ending with a question mark" }),
	header: Type.Optional(Type.String({ maxLength: 24, description: "Very short tag shown above the question, e.g. \"Scope\"" })),
	options: Type.Array(OptionSchema, { minItems: 2, maxItems: 4, description: "2-4 distinct choices; the user can always type their own answer instead" }),
	multiSelect: Type.Optional(Type.Boolean({ description: "True when the user may pick more than one option" })),
});

const AskUserParams = Type.Object({ questions: Type.Array(QuestionSchema, { minItems: 1, maxItems: 4 }) });

export const ASK_USER_DESCRIPTION =
	"Ask the user 1-4 multiple-choice questions and wait for the answers. Use it when a requirement is ambiguous or a decision is consequential and neither the instruction nor the workspace settles it (scope, target, trade-offs, design direction). Do not use it to ask permission for a tool call (approval prompts do that). The user can pick options or type their own answer. If they decline, proceed on your best judgment and state what you assumed.";

export const ASK_USER_DECLINED = "The user declined to answer. Proceed on your best judgment and state what you assumed.";

/** The answers as text for the model: one `Q:` / `A:` pair per question. */
export function formatQuestionAnswer(answer: QuestionAnswer): string {
	return answer.answers
		.map((a) => {
			const parts = [...a.selected];
			if (a.text) parts.push(`(typed) ${a.text}`);
			return `Q: ${a.question}\nA: ${parts.length > 0 ? parts.join(", ") : "(no answer)"}`;
		})
		.join("\n\n");
}

export interface AskUserToolOptions {
	/** Must implement `ask`; the engine only registers the tool when it does and is interactive. */
	prompter: Prompter;
}

/** `ask_user`: structured questions answered through the prompter (TUI box, terminal prompt, or an SDK host's UI). */
export function createAskUserTool(options: AskUserToolOptions): AgentTool<typeof AskUserParams> {
	return {
		name: "ask_user",
		label: "Ask user",
		description: ASK_USER_DESCRIPTION,
		parameters: AskUserParams,
		execute: async (_toolCallId, params, signal) => {
			const { prompter } = options;
			if (!prompter.interactive || !prompter.ask) {
				return {
					content: [{ type: "text", text: "UNAVAILABLE: nobody can answer questions in this run. Proceed on your best judgment and state what you assumed." }],
					details: { code: "UNAVAILABLE" },
					isError: true,
				};
			}
			const request: QuestionRequest = {
				questions: params.questions.map((q) => ({
					question: q.question,
					...(q.header ? { header: q.header } : {}),
					options: q.options.map((o) => ({ label: o.label, ...(o.description ? { description: o.description } : {}) })),
					multiSelect: q.multiSelect === true,
				})),
			};
			const answer = await prompter.ask(request, signal);
			if (!answer) return { content: [{ type: "text", text: ASK_USER_DECLINED }], details: { declined: true } };
			return { content: [{ type: "text", text: formatQuestionAnswer(answer) }], details: answer };
		},
	};
}
