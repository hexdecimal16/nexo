const EPSILON = 1e-9;

/** USD budget of one run. Child runs reserve from it and settle their actual spend back into it. */
export class RunBudget {
	readonly limitUsd: number;
	private spent = 0;
	private reserved = 0;

	constructor(limitUsd: number) {
		this.limitUsd = limitUsd;
	}

	get spentUsd(): number {
		return this.spent;
	}

	get reservedUsd(): number {
		return this.reserved;
	}

	remainingUsd(): number {
		return Math.max(0, this.limitUsd - this.spent - this.reserved);
	}

	remainingFraction(): number {
		return this.limitUsd <= 0 ? 0 : this.remainingUsd() / this.limitUsd;
	}

	canAfford(usd: number): boolean {
		return !this.isExhausted() && usd <= this.remainingUsd() + EPSILON;
	}

	charge(usd: number): void {
		this.spent += usd;
	}

	tryReserve(usd: number): boolean {
		if (usd <= 0 || !this.canAfford(usd)) return false;
		this.reserved += usd;
		return true;
	}

	settleReservation(reservedUsd: number, actualUsd: number): void {
		this.reserved = Math.max(0, this.reserved - reservedUsd);
		this.spent += actualUsd;
	}

	isExhausted(): boolean {
		return this.remainingUsd() <= EPSILON;
	}
}

export function budgetLine(budget: RunBudget): string {
	return `Budget: $${budget.remainingUsd().toFixed(4)} of $${budget.limitUsd.toFixed(2)} remaining`;
}
