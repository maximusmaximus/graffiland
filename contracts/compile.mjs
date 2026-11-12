import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import solc from 'solc';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const contractPath = path.join(__dirname, 'GraffilandNFT.sol');
const outDir = path.join(__dirname, 'build');

function findImports(importPath) {
  const candidates = [
    path.join(__dirname, importPath),
    path.join(rootDir, 'node_modules', importPath)
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return { contents: fs.readFileSync(candidate, 'utf8') };
    }
  }
  return { error: `File not found: ${importPath}` };
}

export function compileContract() {
  const source = fs.readFileSync(contractPath, 'utf8');
  const input = {
    language: 'Solidity',
    sources: {
      'GraffilandNFT.sol': { content: source }
    },
    settings: {
      optimizer: { enabled: true, runs: 200 },
      outputSelection: {
        '*': {
          '*': ['abi', 'evm.bytecode.object']
        }
      }
    }
  };

  const output = JSON.parse(solc.compile(JSON.stringify(input), { import: findImports }));
  if (output.errors) {
    const fatal = output.errors.filter((e) => e.severity === 'error');
    for (const err of output.errors) {
      console[err.severity === 'error' ? 'error' : 'warn'](err.formattedMessage);
    }
    if (fatal.length > 0) {
      throw new Error('Solidity compilation failed');
    }
  }

  const compiled = output.contracts['GraffilandNFT.sol']['GraffilandNFT'];
  fs.mkdirSync(outDir, { recursive: true });
  const artifact = {
    contractName: 'GraffilandNFT',
    abi: compiled.abi,
    bytecode: `0x${compiled.evm.bytecode.object}`
  };
  fs.writeFileSync(path.join(outDir, 'GraffilandNFT.json'), JSON.stringify(artifact, null, 2));
  console.log('Compiled GraffilandNFT.sol -> contracts/build/GraffilandNFT.json');
  return artifact;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  compileContract();
}
