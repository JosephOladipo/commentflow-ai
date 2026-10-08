const { AppError } = require('./posts');

// FEATURE/FUNCTION: Boolean query parser. PURPOSE: Safely parse a small search language without executing user input.
function parseBooleanQuery(input) {
  if (typeof input !== 'string' || !input.trim() || input.length > 300) throw new AppError(400, 'INVALID_BOOLEAN_QUERY', 'Check your AND/OR/NOT operators, quotation marks, or parentheses.');
  const tokens = []; let index = 0;
  while (index < input.length) {
    if (/\s/.test(input[index])) { index++; continue; }
    if ('()'.includes(input[index])) { tokens.push({ type: input[index++] }); continue; }
    if (input[index] === '"') {
      const end = input.indexOf('"', index + 1);
      if (end < 0 || !input.slice(index + 1, end).trim()) throw new AppError(400, 'INVALID_BOOLEAN_QUERY', 'Check your AND/OR/NOT operators, quotation marks, or parentheses.');
      tokens.push({ type: 'TERM', value: input.slice(index + 1, end).trim().toLocaleLowerCase() }); index = end + 1; continue;
    }
    const match = input.slice(index).match(/^[^\s()"]+/);
    if (!match) throw new AppError(400, 'INVALID_BOOLEAN_QUERY', 'Check your AND/OR/NOT operators, quotation marks, or parentheses.');
    const word = match[0]; const upper = word.toUpperCase();
    tokens.push(['AND', 'OR', 'NOT'].includes(upper) ? { type: upper } : { type: 'TERM', value: word.toLocaleLowerCase() }); index += word.length;
  }
  let cursor = 0;
  const peek = () => tokens[cursor]?.type;
  const take = type => { if (peek() !== type) throw new AppError(400, 'INVALID_BOOLEAN_QUERY', 'Check your AND/OR/NOT operators, quotation marks, or parentheses.'); return tokens[cursor++]; };
  const primary = () => {
    if (peek() === 'TERM') return { kind: 'term', value: take('TERM').value };
    if (peek() === '(') { take('('); const node = or(); take(')'); return node; }
    throw new AppError(400, 'INVALID_BOOLEAN_QUERY', 'Check your AND/OR/NOT operators, quotation marks, or parentheses.');
  };
  const unary = () => peek() === 'NOT' ? (take('NOT'), { kind: 'not', child: unary() }) : primary();
  // Adjacent terms and NOT are treated as AND, matching familiar search-box syntax while keeping parsing explicit and safe.
  const and = () => { let node = unary(); while (peek() === 'AND' || peek() === 'TERM' || peek() === '(' || peek() === 'NOT') { if (peek() === 'AND') take('AND'); node = { kind: 'and', left: node, right: unary() }; } return node; };
  const or = () => { let node = and(); while (peek() === 'OR') { take('OR'); node = { kind: 'or', left: node, right: and() }; } return node; };
  const ast = or(); if (cursor !== tokens.length) throw new AppError(400, 'INVALID_BOOLEAN_QUERY', 'Check your AND/OR/NOT operators, quotation marks, or parentheses.');
  return ast;
}
function normalizeText(value) { return String(value || '').normalize('NFKC').toLocaleLowerCase().replace(/\s+/g, ' '); }
// FEATURE/FUNCTION: Boolean evaluator. PURPOSE: Independently verify normalized provider text after discovery.
function evaluateBoolean(ast, text) {
  const source = normalizeText(text);
  const matches = term => source.includes(term) || (!term.includes(' ') && term.length >= 7 && source.includes(term.slice(0, 5)));
  const evaluate = node => node.kind === 'term' ? matches(node.value) : node.kind === 'not' ? !evaluate(node.child) : node.kind === 'and' ? evaluate(node.left) && evaluate(node.right) : evaluate(node.left) || evaluate(node.right);
  return evaluate(ast);
}
function terms(ast, out = []) { if (ast.kind === 'term') out.push(ast.value); else if (ast.kind !== 'term') { terms(ast.left || ast.child, out); if (ast.right) terms(ast.right, out); } return [...new Set(out)]; }
// FEATURE/FUNCTION: Local relevance. PURPOSE: Score genuine text using exact query term coverage rather than provider rank.
function scoreRelevance(ast, text) {
  const source = normalizeText(text), queryTerms = terms(ast); let score = 0;
  for (const term of queryTerms) { const hits = source.split(term).length - 1; if (hits) score += 10 + Math.min(hits - 1, 4) * 3 + (term.includes(' ') ? 8 : 0); }
  for (let i = 0; i < queryTerms.length - 1; i++) if (source.includes(queryTerms[i] + ' ' + queryTerms[i + 1])) score += 6;
  return score;
}
module.exports = { parseBooleanQuery, evaluateBoolean, scoreRelevance, normalizeText };
