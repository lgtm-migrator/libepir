
import epir_t from './epir_t';

const MMAX_MOD = 24
const MMAX = 1 << MMAX_MOD;
const MG_SIZE = 36;

type Wasm = {
	HEAPU8: {
		subarray: (begin: number, end: number) => Uint8Array;
	}
	_free: (ptr: number) => void;
};

class DecryptionContext {
	wasm: Wasm;
	mG: number;
	constructor(wasm: Wasm, mG: number) {
		this.wasm = wasm;
		this.mG = mG;
	}
	getMG(): Uint8Array {
		const mGBuf = this.wasm.HEAPU8.subarray(this.mG, this.mG + MG_SIZE * MMAX);
		return new Uint8Array(mGBuf);
	}
	delete() {
		this.wasm._free(this.mG);
	}
}

const epir = async (): Promise<epir_t<DecryptionContext>> => {
	
	const wasm_ = require('../dist/epir.js');
	const wasm = await wasm_();
	
	wasm._epir_randombytes_init();
	
	const create_privkey = (): Uint8Array => {
		const privkey_ = wasm._malloc(32);
		wasm._epir_create_privkey(privkey_);
		const privkey = new Uint8Array(wasm.HEAPU8.subarray(privkey_, privkey_ + 32));
		wasm._free(privkey_);
		return privkey;
	};
	
	const pubkey_from_privkey = (privkey: Uint8Array): Uint8Array => {
		const privkey_ = wasm._malloc(32);
		wasm.HEAPU8.set(privkey, privkey_);
		const pubkey_ = wasm._malloc(32);
		wasm._epir_pubkey_from_privkey(pubkey_, privkey_);
		const pubkey = new Uint8Array(wasm.HEAPU8.subarray(pubkey_, pubkey_ + 32));
		wasm._free(pubkey_);
		wasm._free(privkey_);
		return pubkey;
	};
	
	const get_decryption_context = async (param?: string | Uint8Array | ((p: number) => void)): Promise<DecryptionContext> => {
		if(param === undefined) {
			const mG = wasm._malloc(MG_SIZE * MMAX);
			wasm._epir_ecelgamal_mg_generate(mG, MMAX, null, null);
			return new DecryptionContext(wasm, mG);
		} else if(typeof param == 'function') {
			const mG = wasm._malloc(MG_SIZE * MMAX);
			const cb = wasm.addFunction((pc: number, data: any) => {
				param(pc);
			}, 'vii');
			wasm._epir_ecelgamal_mg_generate(mG, MMAX, cb, null);
			wasm.removeFunction(cb);
			return new DecryptionContext(wasm, mG);
		} else if(typeof param == 'string') {
			const mGBuf = new Uint8Array(await require('fs/promises').readFile(param));
			return await get_decryption_context(mGBuf);
		} else {
			if(param.length != MG_SIZE * MMAX) {
				throw new Error('The parameter has an invalid length.');
			}
			const mG = wasm._malloc(MG_SIZE * MMAX);
			wasm.HEAPU8.set(param, mG);
			return new DecryptionContext(wasm, mG);
		}
	};
	
	const store_uint64_t = (offset: number, n: number) => {
		for(let i=0; i<8; i++) {
			wasm.HEAPU8[offset + i] = n & 0xff;
			n >>= 8;
		}
	}
	
	type SelectorCreateFunction = (
		selector: number, key: number, index_counts: BigUint64Array, n_index_counts: number,
		idx_low: number, idex_high: number) => void;
	
	const selector_create_ = async (
		key: Uint8Array, index_counts: number[], idx: number, func: SelectorCreateFunction):
		Promise<Uint8Array> => {
		return new Promise((resolve, reject) => {
			const key_ = wasm._malloc(32);
			wasm.HEAPU8.set(key, key_);
			const ic_ = wasm._malloc(8 * index_counts.length);
			for(let i=0; i<index_counts.length; i++) {
				store_uint64_t(ic_ + 8 * i, index_counts[i]);
			}
			const ciphers = wasm._epir_selector_ciphers_count(ic_, index_counts.length);
			const selector_ = wasm._malloc(64 * ciphers);
			func(selector_, key_, ic_, index_counts.length, idx&0xffffffff, Math.floor(idx / 0xffffffff)&0xffffffff);
			const selector = new Uint8Array(wasm.HEAPU8.subarray(selector_, selector_ + 64 * ciphers));
			wasm._free(selector_);
			wasm._free(key_);
			wasm._free(ic_);
			resolve(selector);
		});
	};
	
	const selector_create = (pubkey: Uint8Array, index_counts: number[], idx: number): Promise<Uint8Array> => {
		return selector_create_(pubkey, index_counts, idx, wasm._epir_selector_create);
	};
	
	const selector_create_fast = (privkey: Uint8Array, index_counts: number[], idx: number): Promise<Uint8Array> => {
		return selector_create_(privkey, index_counts, idx, wasm._epir_selector_create_fast);
	};
	
	const reply_decrypt = async (
		ctx: DecryptionContext, reply: Uint8Array, privkey: Uint8Array, dimension: number, packing: number):
		Promise<Uint8Array> => {
		return new Promise((resolve, reject) => {
			const reply_ = wasm._malloc(reply.length);
			wasm.HEAPU8.set(reply, reply_);
			const privkey_ = wasm._malloc(32);
			wasm.HEAPU8.set(privkey, privkey_);
			const bytes = wasm._epir_reply_decrypt(reply_, reply.length, privkey_, dimension, packing, ctx.mG, MMAX);
			if(bytes < 0) {
				reject('Failed to decrypt.');
				return;
			}
			const decrypted = new Uint8Array(wasm.HEAPU8.subarray(reply_, reply_ + bytes));
			wasm._free(reply_);
			wasm._free(privkey_);
			resolve(decrypted);
		});
	};
	
	return {
		create_privkey,
		pubkey_from_privkey,
		get_decryption_context,
		selector_create,
		selector_create_fast,
		reply_decrypt,
	};
	
};

export default epir;

