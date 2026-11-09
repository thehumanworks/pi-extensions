import { type Config, type LoadedConfig, loadConfig } from "./config.ts";
import { Engine } from "./engine.ts";
import type { Classify } from "./judge.ts";
import type { Logger } from "./log.ts";
import { loadRules, type Rule } from "./rules.ts";

export interface Runtime {
	config: Config;
	rules: Rule[];
	warnings: string[];
	configSources: string[];
	engine: Engine;
	/** Why the judge is off, when it is. */
	judgeStatus: string;
}

export interface RuntimeOptions {
	cwd: string;
	home: string;
	env: NodeJS.ProcessEnv;
	/** Read project rules and config. */
	project: boolean;
	/** Builds the judge, or explains why there is none. Only called when some rule needs one. */
	judge: (config: Config) => Classify | { error: string };
	log?: (config: Config) => Logger;
}

/** Whether any loaded rule would ask the judge. */
export function needsJudge(config: Config, rules: Rule[]): boolean {
	return config.judge.mode !== "off" && rules.some((rule) => rule.question !== undefined || (config.judge.confirm && rule.conditions.length > 0));
}

export function loadRuntime(options: RuntimeOptions): Runtime {
	const loaded: LoadedConfig = loadConfig(options);
	const { config } = loaded;
	const ruleSet = loadRules(
		{ cwd: options.cwd, home: options.home, project: options.project, extraDirs: config.ruleDirs, omp: config.importOmpRules },
		config.disabledRules,
	);
	const warnings = [...loaded.warnings, ...ruleSet.warnings];
	let classify: Classify | undefined;
	let judgeStatus = config.judge.mode === "off" ? "off" : "not needed: no rule asks the judge";
	if (needsJudge(config, ruleSet.rules)) {
		const built = options.judge(config);
		if (typeof built === "function") {
			classify = built;
			judgeStatus = `${config.judge.provider}/${config.judge.model}`;
		} else {
			judgeStatus = `unavailable: ${built.error}`;
			const questions = ruleSet.rules.filter((rule) => rule.question).map((rule) => rule.name);
			if (config.judge.mode === "on" || questions.length > 0) {
				warnings.push(`judge ${config.judge.provider}/${config.judge.model} is unavailable (${built.error})${questions.length ? `; question rules stay inactive: ${questions.join(", ")}` : ""}`);
			}
		}
	}
	const log = options.log?.(config);
	return {
		config,
		rules: ruleSet.rules,
		warnings,
		configSources: loaded.sources,
		engine: new Engine({ config, rules: ruleSet.rules, classify, log }),
		judgeStatus,
	};
}
