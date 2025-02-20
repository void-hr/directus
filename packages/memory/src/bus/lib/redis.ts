import type { Redis } from 'ioredis';
import {
	bufferToUint8Array,
	compress,
	decompress,
	deserialize,
	isCompressed,
	serialize,
	uint8ArrayToBuffer,
} from '../../utils/index.js';
import { withNamespace } from '../../utils/with-namespace.js';
import type { Bus, MessageHandler } from '../types/class.js';
import type { BusConfigRedis } from '../types/config.js';

export class BusRedis implements Bus {
	private pub: Redis;
	private sub: Redis;
	private namespace: string;
	private compression: boolean;
	private compressionMinSize: number;
	private handlers: Record<string, Set<MessageHandler<any>>>;

	constructor(config: Omit<BusConfigRedis, 'type'>) {
		this.namespace = config.namespace;
		this.pub = config.redis;
		this.sub = config.redis.duplicate();
		this.sub.on('messageBuffer', this.messageBufferHandler);
		this.compression = config.compression ?? true;
		this.compressionMinSize = config.compressionMinSize ?? 1000;
		this.handlers = {};
	}

	async publish<T = unknown>(channel: string, message: T) {
		let binaryArray = serialize(message);

		if (this.compression === true && binaryArray.byteLength >= this.compressionMinSize) {
			binaryArray = await compress(binaryArray);
		}

		await this.pub.publish(withNamespace(channel, this.namespace), uint8ArrayToBuffer(binaryArray));
	}

	async subscribe<T = unknown>(channel: string, callback: MessageHandler<T>) {
		const namespaced = withNamespace(channel, this.namespace);

		const existingSet = this.handlers[namespaced];

		if (existingSet === undefined) {
			await this.sub.subscribe(namespaced);

			const set = new Set<MessageHandler<T>>();
			set.add(callback);
			this.handlers[namespaced] = set;
		} else {
			existingSet.add(callback);
		}
	}

	async unsubscribe(channel: string, callback: MessageHandler) {
		const namespaced = withNamespace(channel, this.namespace);

		const set = this.handlers[namespaced];

		if (set === undefined) {
			return;
		}

		set.delete(callback);

		if (set.size === 0) {
			delete this.handlers[namespaced];
			this.sub.unsubscribe(namespaced);
		}
	}

	/**
	 * To avoid adding unnecessary active handles in node, we have 1 listener for all messages from
	 * Redis, and call the individual registered callbacks from the handlers object
	 *
	 * @NOTE this method expects the namespaced channel name
	 *
	 * @param namespacedChannel The namespaced channel the message was sent in
	 * @param message Buffer of the message value that was sent in the given channel
	 */
	private async messageBufferHandler(namespacedChannel: string, message: Buffer) {
		if (namespacedChannel in this.handlers === false) {
			return;
		}

		let binaryArray = bufferToUint8Array(message);

		if (this.compression === true && isCompressed(binaryArray)) {
			binaryArray = await decompress(binaryArray);
		}

		const deserialized = deserialize(binaryArray);

		this.handlers[namespacedChannel]?.forEach((callback) => callback(deserialized));
	}
}
