/** One guard per drawer. Changing target or closing invalidates every in-flight read. */
export class ConfigRequestGuard {
    private generation = 0;
    private target = "";
    begin(target: string): {
        target: string;
        generation: number;
    } {
        this.target = target;
        return { target, generation: ++this.generation };
    }
    current(ticket: {
        target: string;
        generation: number;
    }): boolean {
        return ticket.target === this.target && ticket.generation === this.generation;
    }
    invalidate(): void { this.target = ""; this.generation++; }
}
