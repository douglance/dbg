// SQL-like query parser: tokenizer + recursive descent parser

export interface Query {
	columns: string[] | "*";
	table: string;
	where: WhereExpr | null;
	orderBy: { column: string; direction: "ASC" | "DESC" } | null;
	limit: number | null;
}

export type WhereExpr =
	| { type: "comparison"; column: string; op: string; value: string | number }
	| { type: "and"; left: WhereExpr; right: WhereExpr }
	| { type: "or"; left: WhereExpr; right: WhereExpr }
	| { type: "paren"; expr: WhereExpr };

// ─── Tokenizer ───

type TokenType =
	| "keyword"
	| "ident"
	| "number"
	| "string"
	| "op"
	| "comma"
	| "star"
	| "lparen"
	| "rparen";

interface Token {
	type: TokenType;
	value: string;
}

const KEYWORDS = new Set([
	"SELECT",
	"FROM",
	"WHERE",
	"AND",
	"OR",
	"ORDER",
	"BY",
	"ASC",
	"DESC",
	"LIMIT",
	"LIKE",
]);

const OPS = ["<=", ">=", "!=", "=", "<", ">"];

function tokenize(input: string): Token[] {
	const tokens: Token[] = [];
	let i = 0;

	while (i < input.length) {
		// skip whitespace
		if (/\s/.test(input[i])) {
			i++;
			continue;
		}

		// parentheses
		if (input[i] === "(") {
			tokens.push({ type: "lparen", value: "(" });
			i++;
			continue;
		}
		if (input[i] === ")") {
			tokens.push({ type: "rparen", value: ")" });
			i++;
			continue;
		}

		// comma
		if (input[i] === ",") {
			tokens.push({ type: "comma", value: "," });
			i++;
			continue;
		}

		// star
		if (input[i] === "*") {
			tokens.push({ type: "star", value: "*" });
			i++;
			continue;
		}

		// operators (multi-char first)
		let matchedOp = false;
		for (const op of OPS) {
			if (input.slice(i, i + op.length) === op) {
				tokens.push({ type: "op", value: op });
				i += op.length;
				matchedOp = true;
				break;
			}
		}
		if (matchedOp) continue;

		// quoted string
		if (input[i] === "'" || input[i] === '"') {
			const quote = input[i];
			i++;
			let str = "";
			while (i < input.length && input[i] !== quote) {
				if (input[i] === "\\" && i + 1 < input.length) {
					i++;
					str += input[i];
				} else {
					str += input[i];
				}
				i++;
			}
			i++; // skip closing quote
			tokens.push({ type: "string", value: str });
			continue;
		}

		// number
		if (/[0-9]/.test(input[i])) {
			let num = "";
			while (i < input.length && /[0-9.]/.test(input[i])) {
				num += input[i];
				i++;
			}
			tokens.push({ type: "number", value: num });
			continue;
		}

		// identifier or keyword
		if (/[a-zA-Z_]/.test(input[i])) {
			let ident = "";
			while (i < input.length && /[a-zA-Z0-9_]/.test(input[i])) {
				ident += input[i];
				i++;
			}
			const upper = ident.toUpperCase();
			if (KEYWORDS.has(upper)) {
				tokens.push({ type: "keyword", value: upper });
			} else {
				tokens.push({ type: "ident", value: ident });
			}
			continue;
		}

		throw new Error(`Unexpected character: '${input[i]}' at position ${i}`);
	}

	return tokens;
}

// ─── Parser ───

class Parser {
	private tokens: Token[];
	private pos = 0;

	constructor(tokens: Token[]) {
		this.tokens = tokens;
	}

	parse(): Query {
		this.expectKeyword("SELECT");
		const columns = this.parseColumns();
		this.expectKeyword("FROM");
		const table = this.expectIdent();
		const where = this.parseOptionalWhere();
		const orderBy = this.parseOptionalOrderBy();
		const limit = this.parseOptionalLimit();
		return { columns, table, where, orderBy, limit };
	}

	private peek(): Token | undefined {
		return this.tokens[this.pos];
	}

	private advance(): Token {
		const t = this.tokens[this.pos];
		this.pos++;
		return t;
	}

	private expectKeyword(kw: string): void {
		const t = this.advance();
		if (!t || t.type !== "keyword" || t.value !== kw) {
			throw new Error(`Expected keyword '${kw}', got '${t?.value ?? "EOF"}'`);
		}
	}

	private expectIdent(): string {
		const t = this.advance();
		if (!t || t.type !== "ident") {
			throw new Error(`Expected identifier, got '${t?.value ?? "EOF"}'`);
		}
		return t.value;
	}

	private parseColumns(): string[] | "*" {
		const t = this.peek();
		if (t?.type === "star") {
			this.advance();
			return "*";
		}
		const cols: string[] = [];
		cols.push(this.expectIdent());
		while (this.peek()?.type === "comma") {
			this.advance(); // skip comma
			cols.push(this.expectIdent());
		}
		return cols;
	}

	private parseOptionalWhere(): WhereExpr | null {
		if (this.peek()?.type === "keyword" && this.peek()?.value === "WHERE") {
			this.advance();
			return this.parseOrExpr();
		}
		return null;
	}

	private parseOrExpr(): WhereExpr {
		let left = this.parseAndExpr();
		while (this.peek()?.type === "keyword" && this.peek()?.value === "OR") {
			this.advance();
			const right = this.parseAndExpr();
			left = { type: "or", left, right };
		}
		return left;
	}

	private parseAndExpr(): WhereExpr {
		let left = this.parsePrimaryExpr();
		while (this.peek()?.type === "keyword" && this.peek()?.value === "AND") {
			this.advance();
			const right = this.parsePrimaryExpr();
			left = { type: "and", left, right };
		}
		return left;
	}

	private parsePrimaryExpr(): WhereExpr {
		if (this.peek()?.type === "lparen") {
			this.advance();
			const expr = this.parseOrExpr();
			const closing = this.advance();
			if (!closing || closing.type !== "rparen") {
				throw new Error("Expected closing parenthesis");
			}
			return { type: "paren", expr };
		}
		return this.parseComparison();
	}

	private parseComparison(): WhereExpr {
		const column = this.expectIdent();
		const opToken = this.advance();
		if (!opToken) throw new Error("Expected operator");

		let op: string;
		if (opToken.type === "op") {
			op = opToken.value;
		} else if (opToken.type === "keyword" && opToken.value === "LIKE") {
			op = "LIKE";
		} else {
			throw new Error(`Expected operator, got '${opToken.value}'`);
		}

		const valueToken = this.advance();
		if (!valueToken) throw new Error("Expected value");

		let value: string | number;
		if (valueToken.type === "number") {
			value = Number(valueToken.value);
		} else if (valueToken.type === "string") {
			value = valueToken.value;
		} else if (valueToken.type === "ident") {
			value = valueToken.value;
		} else {
			throw new Error(`Expected value, got '${valueToken.value}'`);
		}

		return { type: "comparison", column, op, value };
	}

	private parseOptionalOrderBy(): {
		column: string;
		direction: "ASC" | "DESC";
	} | null {
		if (this.peek()?.type === "keyword" && this.peek()?.value === "ORDER") {
			this.advance();
			this.expectKeyword("BY");
			const column = this.expectIdent();
			let direction: "ASC" | "DESC" = "ASC";
			if (
				this.peek()?.type === "keyword" &&
				(this.peek()?.value === "ASC" || this.peek()?.value === "DESC")
			) {
				direction = this.advance().value as "ASC" | "DESC";
			}
			return { column, direction };
		}
		return null;
	}

	private parseOptionalLimit(): number | null {
		if (this.peek()?.type === "keyword" && this.peek()?.value === "LIMIT") {
			this.advance();
			const t = this.advance();
			if (!t || t.type !== "number") {
				throw new Error(
					`Expected number after LIMIT, got '${t?.value ?? "EOF"}'`,
				);
			}
			return Number(t.value);
		}
		return null;
	}
}

export function parseQuery(sql: string): Query {
	const tokens = tokenize(sql);
	const parser = new Parser(tokens);
	return parser.parse();
}
