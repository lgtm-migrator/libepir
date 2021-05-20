
import {
	EpirBase,
	EpirCreateFunction,
	DecryptionContextBase,
	DecryptionContextParameter,
	DecryptionContextCallback,
	DecryptionContextCallbackFunction,
	DecryptionContextCreateFunction,
	DEFAULT_MMAX,
	SCALAR_SIZE,
	POINT_SIZE,
	CIPHER_SIZE
} from './EpirBase';
import EPIRWorker from './wasm.worker.ts';

const time = () => new Date().getTime();

export const MG_SIZE = 36;
export const MG_P3_SIZE = 4 * 40;

import { LibEpir as Wasm } from './wasm.libepir';

const uint8ArrayConcat = (arr: Uint8Array[]) => {
	const len = arr.reduce((acc, v) => acc + v.length, 0);
	const ret = new Uint8Array(len);
	for(let i=0, offset=0; i<arr.length; i++) {
		ret.set(arr[i], offset);
		offset += arr[i].length;
	}
	return ret;
}

const uint8ArrayCompare = (a: Uint8Array, b: Uint8Array, len: number = Math.min(a.length, b.length)): number => {
	for(let i=0; i<len; i++) {
		if(a[i] == b[i]) continue;
		return a[i] - b[i];
	}
	return 0;
}

const getRandomBytes = (len: number) => {
	if(window && window.crypto && window.crypto.getRandomValues) {
		const MAX_ENTROPY = 65536;
		const ret = new Uint8Array(len);
		for(let offset=0; offset<len; offset+=MAX_ENTROPY) {
			window.crypto.getRandomValues(ret.subarray(offset, Math.min(len, offset + MAX_ENTROPY)));
		}
		return ret;
	} else {
		const crypto = require('crypto');
		return crypto.randomBytes(len);
	}
};

export const isCanonical = (buf: Uint8Array): boolean => {
	let c = (buf[31] & 0x7f) ^ 0x7f;
	for(let i=30; i>0; i--) {
		c |= buf[i] ^ 0xff;
	}
	const d = (0xed - 1 - buf[0]) >> 8;
	return !((c == 0) && d)
};

export const isZero = (buf: Uint8Array): boolean => {
	return buf.reduce<boolean>((acc, v) => acc && (v == 0), true);
};

export const getRandomScalar = () => {
	for(;;) {
		const scalar = getRandomBytes(SCALAR_SIZE);
		scalar[31] &= 0x1f;
		if(!isCanonical(scalar) || isZero(scalar)) continue;
		return scalar;
	}
};

const getRandomScalars = (cnt: number) => {
	const ret: Uint8Array[] = [];
	for(let i=0; i<cnt; i++) ret.push(getRandomScalar());
	return ret;
}

class WasmHelper {
	
	wasm: Wasm;
	
	constructor(wasm: Wasm) {
		this.wasm = wasm;
	}
	
	store_uint32_t(offset: number, n: number) {
		for(let i=0; i<4; i++) {
			this.wasm.HEAPU8[offset + i] = n & 0xff;
			n >>= 8;
		}
	}
	
	store_uint64_t(offset: number, n: number) {
		for(let i=0; i<8; i++) {
			this.wasm.HEAPU8[offset + i] = n & 0xff;
			n >>= 8;
		}
	}
	
	set(buf: Uint8Array, offset: number) {
		this.wasm.HEAPU8.set(buf, offset);
	}
	
	malloc(param: Uint8Array | number): number {
		if(typeof param == 'number') {
			return this.wasm._malloc(param);
		} else {
			const buf_ = this.wasm._malloc(param.length);
			this.wasm.HEAPU8.set(param, buf_);
			return buf_;
		}
	}
	
	free(buf_: number) {
		this.wasm._free(buf_);
	}
	
	call(func: string, ...params: any[]) {
		return this.wasm[`_epir_${func}`].apply(null, params);
	}
	
	slice(begin: number, len: number) {
		return this.wasm.HEAPU8.slice(begin, begin + len);
	}
	
	subarray(begin: number, len: number) {
		return this.wasm.HEAPU8.subarray(begin, begin + len);
	}
	
}

export class DecryptionContext implements DecryptionContextBase {
	
	helper: WasmHelper;
	mG: Uint8Array;
	workers: EPIRWorker[] = [];
	
	constructor(helper: WasmHelper, mG: Uint8Array, nThreads: number = navigator.hardwareConcurrency) {
		this.helper = helper;
		this.mG = mG;
		for(let t=0; t<nThreads; t++) this.workers.push(new EPIRWorker());
	}
	
	getMG(): Uint8Array {
		return this.mG;
	}
	
	decryptCipher(privkey: Uint8Array, cipher: Uint8Array): number {
		const privkey_ = this.helper.malloc(SCALAR_SIZE);
		this.helper.set(privkey, privkey_);
		const cipher_ = this.helper.malloc(CIPHER_SIZE);
		this.helper.set(cipher, cipher_);
		this.helper.call('ecelgamal_decrypt_to_mG', privkey_, cipher_);
		const mG = this.helper.subarray(cipher_, POINT_SIZE);
		const decrypted = this.interpolationSearch(mG);
		this.helper.free(privkey_);
		this.helper.free(cipher_);
		if(decrypted < 0) throw new Error('Failed to decrypt.');
		return decrypted;
	}
	
	async decryptReply(privkey: Uint8Array, dimension: number, packing: number, reply: Uint8Array): Promise<Uint8Array> {
		let midstate = reply;
		for(let phase=0; phase<dimension; phase++) {
			const decrypted = await this.decryptMany(midstate, privkey, packing);
			if(phase == dimension - 1) {
				midstate = decrypted;
			} else {
				midstate = decrypted.subarray(0, decrypted.length - (decrypted.length % CIPHER_SIZE));
			}
		}
		return midstate;
	}
	
	static load_uint32_t(buf: Uint8Array, le: boolean = false): number {
		if(le) {
			return (buf[3] * (1 << 24)) + (buf[2] << 16) + (buf[1] << 8) + buf[0];
		} else {
			return (buf[0] * (1 << 24)) + (buf[1] << 16) + (buf[2] << 8) + buf[3];
		}
	}
	
	load_uint32_t_from_mG(idx: number): number {
		return DecryptionContext.load_uint32_t(this.mG.subarray(MG_SIZE * idx, MG_SIZE * idx + 4));
	}
	
	interpolationSearch(mG: Uint8Array): number {
		const mmax = this.mG.length / MG_SIZE;
		let imin = 0;
		let imax = mmax - 1;
		let left = this.load_uint32_t_from_mG(0);
		let right = this.load_uint32_t_from_mG(mmax - 1);
		const my = DecryptionContext.load_uint32_t(mG);
		for(; imin<=imax; ) {
			const imid = imin + Math.floor((imax - imin) * (my - left) / (right - left));
			const cmp = uint8ArrayCompare(this.mG.subarray(MG_SIZE * imid, MG_SIZE * imid + POINT_SIZE), mG);
			if(cmp < 0) {
				imin = imid + 1;
				left = this.load_uint32_t_from_mG(imid);
			} else if(cmp > 0) {
				imax = imid - 1;
				right = this.load_uint32_t_from_mG(imid);
			} else {
				return DecryptionContext.load_uint32_t(this.mG.subarray(MG_SIZE * imid + POINT_SIZE, MG_SIZE * imid + MG_SIZE), true);
			}
		}
		return -1;
	}
	
	async decryptMany(ciphers: Uint8Array, privkey: Uint8Array, packing: number): Promise<Uint8Array> {
		const nThreads = this.workers.length;
		const ciphersCount = ciphers.length / CIPHER_SIZE;
		const mGs = await Promise.all(this.workers.map((worker, i): Promise<Uint8Array> => {
			return new Promise((resolve, reject) => {
				worker.onmessage = (ev) => {
					switch(ev.data.method) {
						case 'decrypt_mG_many':
							resolve(ev.data.mG);
							break;
					}
				};
				const ciphersPerThread = Math.ceil(ciphersCount / nThreads);
				const begin = i * ciphersPerThread;
				const end = Math.min(ciphersCount + 1, (i + 1) * ciphersPerThread);
				const ciphersMy = ciphers.subarray(begin * CIPHER_SIZE, end * CIPHER_SIZE);
				worker.postMessage({
					method: 'decrypt_mG_many', ciphers: ciphersMy, privkey: privkey,
				});
			});
		}));
		const ms: number[] = [];
		for(const mG of mGs) {
			for(let i=0; POINT_SIZE*i<mG.length; i++) {
				ms.push(this.interpolationSearch(mG.subarray(i * POINT_SIZE, (i + 1) * POINT_SIZE)));
			}
		}
		const decrypted = new Uint8Array(packing * ciphersCount);
		for(let i=0; i<ms.length; i++) {
			const m = ms[i];
			if(m == -1) throw new Error('Failed to decrypt.');
			for(let p=0; p<packing; p++) {
				decrypted[i * packing + p] = (m >> (8 * p)) & 0xff;
			}
		}
		return decrypted;
	}
	
}

const mGGeneratePrepare = (helper: WasmHelper, nThreads: number, mmax: number, cb: undefined | DecryptionContextCallback) => {
	const CTX_SIZE = 124;
	const ctx_ = helper.malloc(CTX_SIZE);
	helper.store_uint32_t(ctx_, mmax);
	const mG_ = helper.malloc(nThreads * MG_SIZE);
	const mG_p3_ = helper.malloc(nThreads * MG_P3_SIZE);
	if(cb) {
		let pointsComputed = 0;
		const cb_ = helper.wasm.addFunction((data: any) => {
			pointsComputed++;
			if(pointsComputed % cb.interval != 0) return;
			cb.cb(pointsComputed);
		}, 'vi');
		helper.call('mG_generate_prepare', ctx_, mG_, mG_p3_, nThreads, cb_, null);
		helper.wasm.removeFunction(cb_);
	} else {
		helper.call('mG_generate_prepare', ctx_, mG_, mG_p3_, nThreads, null, null);
	}
	const ctx = helper.slice(ctx_, CTX_SIZE);
	const mG = helper.slice(mG_, nThreads * MG_SIZE);
	const mG_p3 = helper.slice(mG_p3_, nThreads * MG_P3_SIZE);
	helper.free(ctx_);
	helper.free(mG_);
	helper.free(mG_p3_);
	return { ctx: ctx, mG: mG, mG_p3: mG_p3 };
};

const mGGenerate = async (helper: WasmHelper, mG_: number, cb: undefined | DecryptionContextCallback, mmax: number): Promise<void> => {
	// XXX: not working for navigator.hardwareConcurrency.
	const nThreads = navigator.hardwareConcurrency / 2;
	const workers: EPIRWorker[] = [];
	for(let i=0; i<nThreads; i++) {
		workers.push(new EPIRWorker());
	}
	const mG: Uint8Array[] = [];
	const beginCompute = time();
	const prepare = mGGeneratePrepare(helper, nThreads, mmax, cb);
	for(let t=0; t<nThreads; t++) {
		mG.push(prepare.mG.subarray(t * MG_SIZE, (t + 1) * MG_SIZE));
	}
	let pointsComputed = nThreads;
	const promises = workers.map(async (worker, workerId) => {
		return new Promise<void>((resolve, reject) => {
			worker.onmessage = (ev) => {
				switch(ev.data.method) {
					case 'mg_generate_cb':
						pointsComputed++;
						if(!cb) break;
						if(pointsComputed % cb.interval != 0 && pointsComputed != mmax) break;
						cb.cb(pointsComputed);
						break;
					case 'mg_generate_compute':
						//console.log(`mg_generate_compute (workerId = ${workerId}) DONE.`);
						for(let i=0; i*MG_SIZE<ev.data.mG.length; i++) {
							mG.push(ev.data.mG.subarray(i * MG_SIZE, (i + 1) * MG_SIZE));
						}
						resolve();
						break;
				}
			};
			workers[workerId].postMessage({
				method: 'mg_generate_compute', nThreads: nThreads, mmax: mmax,
				ctx: prepare.ctx, mG_p3: prepare.mG_p3.slice(MG_P3_SIZE * workerId, MG_P3_SIZE * (workerId + 1)),
				threadId: workerId,
			});
		});
	});
	await Promise.all(promises);
	//console.log(`Computation done in ${(time() - beginCompute).toLocaleString()}ms.`);
	//console.log('Sorting...');
	const beginSort = time();
	mG.sort((a, b) => {
		return uint8ArrayCompare(a, b, POINT_SIZE);
	});
	//console.log(`Sorting done in ${(time() - beginSort).toLocaleString()}ms.`);
	for(let i=0; i<mmax; i++) {
		helper.set(mG[i], mG_ + i * MG_SIZE);
	}
}

const getMG = async (helper: WasmHelper, param: undefined | string | DecryptionContextCallback, mmax: number): Promise<Uint8Array> => {
	if(typeof param == 'string') {
		return new Uint8Array(await require('fs').promises.readFile(param));
	} else {
		const mG_ = helper.malloc(MG_SIZE * mmax);
		await mGGenerate(helper, mG_, param, mmax);
		const mG = helper.slice(mG_, MG_SIZE * mmax);
		helper.free(mG_);
		return mG;
	}
}

export const createDecryptionContext: DecryptionContextCreateFunction = async (
	param?: DecryptionContextParameter, mmax: number = DEFAULT_MMAX) => {
	const { libEpirModule } = await import('./wasm.libepir');
	const wasm = await libEpirModule();
	const helper = new WasmHelper(wasm);
	const mG = (param instanceof Uint8Array ? param : await getMG(helper, param, mmax));
	return new DecryptionContext(helper, mG);
};

export class Epir implements EpirBase {
	
	helper: WasmHelper;
	workers: EPIRWorker[] = [];
	
	constructor(helper: WasmHelper, nThreads: number = navigator.hardwareConcurrency) {
		this.helper = helper;
		for(let t=0; t<nThreads; t++) this.workers.push(new EPIRWorker());
	}
	
	createPrivkey(): Uint8Array {
		return getRandomScalar();
	}
	
	createPubkey(privkey: Uint8Array): Uint8Array {
		const privkey_ = this.helper.malloc(privkey);
		const pubkey_ = this.helper.malloc(POINT_SIZE);
		this.helper.call('pubkey_from_privkey', pubkey_, privkey_);
		const pubkey = this.helper.slice(pubkey_, POINT_SIZE);
		this.helper.free(pubkey_);
		this.helper.free(privkey_);
		return pubkey;
	}
	
	encrypt_(
		key: Uint8Array, msg: number, r: Uint8Array | undefined,
		encrypt: string): Uint8Array {
		const key_ = this.helper.malloc(key);
		const cipher_ = this.helper.malloc(CIPHER_SIZE);
		const rr_ = this.helper.malloc(r ? r : getRandomScalar());
		this.helper.call(encrypt, cipher_, key_, msg&0xffffffff, Math.floor(msg/0x100000000), rr_);
		this.helper.free(rr_);
		const cipher = this.helper.slice(cipher_, CIPHER_SIZE);
		this.helper.free(key_);
		this.helper.free(cipher_);
		return cipher;
	}
	
	encrypt(pubkey: Uint8Array, msg: number, r?: Uint8Array): Uint8Array {
		return this.encrypt_(pubkey, msg, r, 'ecelgamal_encrypt');
	}
	
	encryptFast(privkey: Uint8Array, msg: number, r?: Uint8Array): Uint8Array {
		return this.encrypt_(privkey, msg, r, 'ecelgamal_encrypt_fast');
	}
	
	ciphers_or_elements_count(index_counts: number[], count: string): number {
		const ic_ = this.helper.malloc(8 * index_counts.length);
		for(let i=0; i<index_counts.length; i++) {
			this.helper.store_uint64_t(ic_ + 8 * i, index_counts[i]);
		}
		const c = this.helper.call(count, ic_, index_counts.length);
		this.helper.free(ic_);
		return c;
	}
	
	ciphersCount(index_counts: number[]): number {
		return this.ciphers_or_elements_count(index_counts, 'selector_ciphers_count');
	}
	
	elementsCount(index_counts: number[]): number {
		return this.ciphers_or_elements_count(index_counts, 'selector_elements_count');
	}
	
	create_choice(index_counts: number[], idx: number): Uint8Array {
		const ic_ = this.helper.malloc(8 * index_counts.length);
		for(let i=0; i<index_counts.length; i++) {
			this.helper.store_uint64_t(ic_ + 8 * i, index_counts[i]);
		}
		const ciphers = this.helper.call('selector_ciphers_count', ic_, index_counts.length);
		const selector_ = this.helper.malloc(CIPHER_SIZE * ciphers);
		this.helper.call('selector_create_choice',
			selector_, ic_, index_counts.length, idx&0xffffffff, Math.floor(idx / 0xffffffff)&0xffffffff);
		const selector = this.helper.slice(selector_, CIPHER_SIZE * ciphers);
		this.helper.free(selector_);
		this.helper.free(ic_);
		return selector;
	}
	
	async selector_create_(
		key: Uint8Array, index_counts: number[], idx: number, r: Uint8Array | undefined, isFast: boolean): Promise<Uint8Array> {
		return new Promise(async (resolve, reject) => {
			const nThreads = this.workers.length;
			const promises: Promise<Uint8Array>[] = [];
			const random = r ? r : uint8ArrayConcat(getRandomScalars(this.ciphersCount(index_counts)));
			const choice = this.create_choice(index_counts, idx);
			for(let t=0; t<nThreads; t++) {
				promises.push(new Promise((resolve, reject) => {
					this.workers[t].onmessage = (ev) => {
						switch(ev.data.method) {
							case 'selector_create':
								resolve(ev.data.selector);
								break;
						}
					};
				}));
				const ciphersPerThread = Math.ceil((choice.length / CIPHER_SIZE) / nThreads);
				const begin = t * ciphersPerThread;
				const end = Math.min((choice.length / CIPHER_SIZE) + 1, (t + 1) * ciphersPerThread);
				const choice_t = choice.subarray(begin * CIPHER_SIZE, end * CIPHER_SIZE);
				this.workers[t].postMessage({
					method: 'selector_create',
					choice: choice_t, key: key, random: random.subarray(begin * SCALAR_SIZE, end * SCALAR_SIZE), isFast: isFast
				});
			}
			const selectors = await Promise.all(promises);
			resolve(uint8ArrayConcat(selectors));
		});
	}
	
	async createSelector(pubkey: Uint8Array, index_counts: number[], idx: number, r?: Uint8Array): Promise<Uint8Array> {
		return this.selector_create_(pubkey, index_counts, idx, r, false);
	}
	
	async createSelectorFast(privkey: Uint8Array, index_counts: number[], idx: number, r?: Uint8Array): Promise<Uint8Array> {
		return this.selector_create_(privkey, index_counts, idx, r, true);
	}
	
	// For testing.
	computeReplySize(dimension: number, packing: number, elem_size: number): number {
		return this.helper.call('reply_size', dimension, packing, elem_size);
	}
	
	computeReplyRCount(dimension: number, packing: number, elem_size: number): number {
		return this.helper.call('reply_r_count', dimension, packing, elem_size);
	}
	
	computeReplyMock(pubkey: Uint8Array, dimension: number, packing: number, elem: Uint8Array, r?: Uint8Array): Uint8Array {
		const pubkey_ = this.helper.malloc(pubkey);
		const elem_ = this.helper.malloc(elem);
		const rrc = this.computeReplyRCount(dimension, packing, elem.length);
		const rr_ = this.helper.malloc(r ? r : uint8ArrayConcat(getRandomScalars(rrc)));
		const rs = this.computeReplySize(dimension, packing, elem.length);
		const reply_ = this.helper.malloc(rs);
		this.helper.call('reply_mock', reply_, pubkey_, dimension, packing, elem_, elem.length, rr_);
		const reply = this.helper.slice(reply_, rs);
		this.helper.free(pubkey_);
		this.helper.free(elem_);
		this.helper.free(rr_);
		this.helper.free(reply_);
		return reply;
	}
	
}

export const createEpir: EpirCreateFunction = async () => {
	const { libEpirModule } = await import('./wasm.libepir');
	const wasm = await libEpirModule();
	const helper = new WasmHelper(wasm);
	return new Epir(helper);
};

