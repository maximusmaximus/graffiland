import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import solc from 'solc';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const outDir = path.join(__dirname, 'build');

const CONTRACT_SOURCES = [
  { file: 'GraffilandNFT.sol', contractName: 'GraffilandNFT' },
  { file: 'GraffilandLandDeed.sol', contractName: 'GraffilandLandDeed' },
  { file: 'GraffilandRoyaltyRouter.sol', contractName: 'GraffilandRoyaltyRouter' },
  { file: 'GraffilandMarketplace.sol', contractName: 'GraffilandMarketplace' }
];

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

export function compileAllContracts() {
  const sources = {};
  for (const item of CONTRACT_SOURCES) {
    sources[item.file] = {
      content: fs.readFileSync(path.join(__dirname, item.file), 'utf8')
    };
  }

  const input = {
    language: 'Solidity',
    sources,
    settings: {
      optimizer: { enabled: true, runs: 200 },
      viaIR: true,
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

  fs.mkdirSync(outDir, { recursive: true });
  const artifacts = {};
  for (const item of CONTRACT_SOURCES) {
    const compiled = output.contracts[item.file][item.contractName];
    const artifact = {
      contractName: item.contractName,
      abi: compiled.abi,
      bytecode: `0x${compiled.evm.bytecode.object}`
    };
    fs.writeFileSync(
      path.join(outDir, `${item.contractName}.json`),
      JSON.stringify(artifact, null, 2)
    );
    artifacts[item.contractName] = artifact;
  }
  console.log(
    'Compiled GraffilandNFT.sol, GraffilandLandDeed.sol, GraffilandRoyaltyRouter.sol, GraffilandMarketplace.sol -> contracts/build/'
  );
  return artifacts;
}

export function compileContract() {
  const artifacts = compileAllContracts();
  return artifacts.GraffilandNFT;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  compileAllContracts();
}
