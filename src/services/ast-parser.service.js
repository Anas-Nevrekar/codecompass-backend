import Parser from 'tree-sitter';
import JavaScript from 'tree-sitter-javascript';
import Python from 'tree-sitter-python';
import TypeScript from 'tree-sitter-typescript';

const grammars = {
  '.js': ['javascript', JavaScript], '.jsx': ['javascript', JavaScript], '.mjs': ['javascript', JavaScript], '.cjs': ['javascript', JavaScript],
  '.ts': ['typescript', TypeScript.typescript], '.tsx': ['typescript', TypeScript.tsx], '.mts': ['typescript', TypeScript.typescript], '.cts': ['typescript', TypeScript.typescript],
  '.py': ['python', Python]
};

function childText(node, source) { return node ? source.slice(node.startIndex, node.endIndex) : null; }
function nameFrom(node, source) {
  const name = node.childForFieldName('name');
  if (name) return childText(name, source);
  if (node.type === 'arrow_function' || node.type === 'function_expression') {
    const parent = node.parent;
    if (parent?.type === 'variable_declarator') {
      const declarationName = parent.childForFieldName('name');
      if (declarationName) return childText(declarationName, source);
    }
  }
  const pending = [...(node.namedChildren ?? [])];
  while (pending.length) {
    const child = pending.shift();
    if (['identifier', 'property_identifier'].includes(child.type)) return childText(child, source);
    pending.unshift(...(child.namedChildren ?? []));
  }
  return null;
}
function importMetadata(node, source) {
  if (node.type === 'import_statement') {
    const stringNode = (node.namedChildren ?? []).find((child) => child.type === 'string');
    const moduleName = stringNode ? childText(stringNode, source).replace(/^['"]|['"]$/g, '') : null;
    const identifiers = (node.namedChildren ?? []).flatMap((child) => child.type === 'import_clause' ? (child.namedChildren ?? []).map((item) => childText(item, source)) : []);
    return { moduleName, importedIdentifiers: identifiers };
  }
  if (node.type === 'import_from_statement') {
    const moduleNode = node.childForFieldName('module_name');
    return { moduleName: childText(moduleNode, source), importedIdentifiers: (node.namedChildren ?? []).filter((child) => child.type === 'dotted_name' || child.type === 'identifier').map((child) => childText(child, source)) };
  }
  return {};
}

export function parseSource(source, extension) {
  const grammar = grammars[extension.toLowerCase()];
  if (!grammar) return { supported: false, chunks: [], hasErrors: false };
  if (!source.trim()) return { supported: true, chunks: [], hasErrors: false };
  const parser = new Parser();
  parser.setLanguage(grammar[1]);
  const tree = parser.parse(source);
  const chunks = [];
  const visited = new Set();
  function visit(node) {
    let type = null;
    const grammarName = grammar[0];
    if (grammarName === 'javascript' || grammarName === 'typescript') {
      if (['function_declaration', 'function_expression', 'arrow_function', 'method_definition'].includes(node.type)) type = 'function';
      else if (node.type === 'class_declaration' || node.type === 'class') type = 'class';
      else if (node.type === 'import_statement') type = 'import';
      else if (node.type === 'lexical_declaration' || node.type === 'variable_declaration') type = 'variable';
    } else {
      if (['function_definition', 'lambda'].includes(node.type)) type = 'function';
      else if (node.type === 'class_definition') type = 'class';
      else if (node.type === 'import_statement' || node.type === 'import_from_statement') type = 'import';
      else if (node.type === 'assignment' || node.type === 'augmented_assignment') type = 'variable';
    }
    if (type && node.endIndex > node.startIndex) {
      const sourceCode = childText(node, source);
      const key = `${type}:${node.startIndex}:${node.endIndex}`;
      if (!visited.has(key) && sourceCode.trim()) {
        visited.add(key);
        chunks.push({
          structureType: type,
          symbolName: type === 'import' ? null : nameFrom(node, source),
          startLine: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
          source: sourceCode,
          metadata: type === 'import' ? importMetadata(node, source) : {}
        });
      }
    }
    for (const child of node.namedChildren ?? []) visit(child);
  }
  visit(tree.rootNode);
  return { supported: true, chunks, hasErrors: tree.rootNode.hasError };
}

export function languageForExtension(extension) { return grammars[extension.toLowerCase()]?.[0] ?? null; }
