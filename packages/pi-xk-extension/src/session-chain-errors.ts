export class SessionChainControllerError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SessionChainControllerError";
	}
}
