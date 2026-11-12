import 'dotenv/config';
import { ethers } from 'ethers';
import { compileContract } from './compile.mjs';

const NETWORKS = {
  testnet: {
    name: 'Robinhood Chain Testnet',
    chainId: 46630,
    rpcUrl: process.env.ROBINHOOD_TESTNET_RPC || 'https://rpc.testnet.chain.robinhood.com',
    explorer: 'https://explorer.testnet.chain.robinhood.com'
  },
  mainnet: {
    name: 'Robinhood Chain Mainnet',
    chainId: 4663,
    rpcUrl: process.env.ROBINHOOD_MAINNET_RPC || 'https://rpc.mainnet.chain.robinhood.com',
    explorer: 'https://robinhoodchain.blockscout.com'
  }
};

async function main() {
  const target = (process.env.ROBINHOOD_NETWORK || 'testnet').toLowerCase();
  const net = NETWORKS[target];
  if (!net) throw new Error(`Unknown ROBINHOOD_NETWORK: ${target}`);

  const privateKey = process.env.ROBINHOOD_RELAYER_PRIVATE_KEY;
  if (!privateKey) {
    throw new Error('Missing ROBINHOOD_RELAYER_PRIVATE_KEY in .env');
  }

  const artifact = compileContract();
  const provider = new ethers.JsonRpcProvider(net.rpcUrl, net.chainId);
  const wallet = new ethers.Wallet(privateKey, provider);
  const royaltyReceiver = process.env.ROBINHOOD_ROYALTY_RECEIVER || wallet.address;

  console.log(`Deploying GraffilandNFT to ${net.name} (${net.chainId}) from ${wallet.address}...`);
  console.log(`Default 5% (500 bps) ERC-2981 royalty receiver: ${royaltyReceiver}`);

  const factory = new ethers.ContractFactory(artifact.abi, artifact.bytecode, wallet);
  const contract = await factory.deploy(wallet.address, wallet.address, royaltyReceiver);
  console.log(`Tx submitted: ${contract.deploymentTransaction().hash}`);
  await contract.waitForDeployment();
  const address = await contract.getAddress();

  console.log(`GraffilandNFT deployed at: ${address}`);
  console.log(`Explorer: ${net.explorer}/address/${address}`);
  console.log(`\nAdd to .env:\nROBINHOOD_CONTRACT_ADDRESS=${address}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
