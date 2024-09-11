import Fastify from "fastify";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import Groq from "groq-sdk";

import { clerkClient, clerkPlugin } from "@clerk/fastify";
import {
	doc,
	getDoc,
	arrayUnion,
	runTransaction,
	updateDoc,
	Timestamp,
} from "firebase/firestore";
import { firestore } from "./firebase.js";
import { v4 as uuidv4 } from "uuid";

const fastify = Fastify();

await fastify.register(cors, {
	origin: process.env.FRONTEND_URL,
	methods: ["GET", "POST", "PATCH"],
});

fastify.register(clerkPlugin);
await fastify.register(websocket);

let users = {};
let groups = {};

//
// Websocket connection endpoint
fastify.get("/message", { websocket: true }, async (socket, req) => {
	// ---------- To authenticate user on connection ----------
	const userId = req.query?.userId;
	const groupId = req.query?.groupId;

	if (!userId) throw new Error("User id is required.");
	if (!groupId) throw new Error("Group id is required.");

	const groupRef = doc(firestore, "groups", groupId);

	try {
		const user = await clerkClient.users.getUser(userId);
		const name = (user.firstName + " " + user.lastName).trim();

		// To fetch group data
		const groupSnap = await getDoc(groupRef);
		if (!groupSnap.exists()) throw new Error("Group does not exist.");

		const group = groupSnap.data();
		const isJoined = group.members.some((id) => id === userId);

		if (!isJoined) throw new Error("User not joined the group.");
		users[user.id] = { name: name ? name : user.id };
		groups[groupId] = { members: group.members };
		socket.id = userId;
		socket.groupId = groupId;
		//
	} catch (err) {
		return socket.close(4001, "Error: Unauthorized.");
	}

	// ---------- To handle message event ----------
	socket.on("message", async (data) => {
		if (!users[userId]) return socket.close(4001, "Error: Unauthorized.");

		const message = data.toString().trim();
		if (!message) return;

		data = {
			userId,
			name: users[userId].name,
			message,
			timestamp: Timestamp.fromDate(new Date()),
		};

		await updateDoc(groupRef, {
			messages: arrayUnion(data),
		});

		fastify.websocketServer.clients.forEach((client) => {
			if (
				client.readyState === 1 &&
				client.groupId === groupId &&
				groups[groupId].members.includes(client.id)
			)
				client.send(JSON.stringify(data));
		});
	});

	// ---------- To handle close event ----------
	socket.on("close", () => {
		delete users[userId];
		groups[groupId].members = groups[groupId].members.filter(
			(id) => id !== userId
		);
	});
});

//
// ---------- Chat with AI ----------

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

fastify.post("/chat", async (req, res) => {
	const { userId, groupId, data } = JSON.parse(await req.body);

	if (!userId) return res.code(400).send("User id is required.");
	if (!groupId) return res.code(400).send("Group id is required.");
	if (!data)
		return res.code(400).send("Message is required to chat with AI.");
	if (!users[userId]) return res.code(401).send("Unauthenticated.");

	const messages = data.messages?.map((user) => {
		return { role: "user", content: user.message };
	});

	const completion = await groq.chat.completions.create({
		model: process.env.MODEL,
		temperature: 0.5,
		max_tokens: 1024,
		stream: false,
		messages: [
			{ role: "system", content: "You are a support assistant." },
			...messages,
			{ role: "user", content: data.query },
		],
	});

	const message = completion.choices[0]?.message?.content || "";

	const obj = {
		userId,
		name: users[userId].name,
		query: data.query,
		message,
		timestamp: Timestamp.fromDate(new Date()),
	};

	const groupRef = doc(firestore, "groups", groupId);
	await updateDoc(groupRef, {
		messages: arrayUnion(obj),
	});

	fastify.websocketServer.clients.forEach((client) => {
		if (
			client.readyState === 1 &&
			client.groupId === groupId &&
			groups[groupId].members.includes(client.id)
		)
			client.send(JSON.stringify(obj));
	});
});

//
// ---------- Messages ----------

// Fetch messages by group
fastify.get("/messages", async (req, res) => {
	const groupId = req.query?.groupId;
	const userId = req.query?.userId;

	if (!userId) return res.code(400).send("User id is required.");
	if (!groupId) return res.code(400).send("Group id is required.");
	await clerkClient.users.getUser(userId);

	// To fetch group data
	const groupRef = doc(firestore, "groups", groupId);
	const groupSnap = await getDoc(groupRef);
	if (!groupSnap.exists()) return res.code(404).send("Group does not exist.");

	const data = groupSnap.data();
	const isJoined = data.members.some((id) => id === userId);
	if (!isJoined) return res.code(403).send("User not joined the group.");

	return res.send(data);
});

//
// ---------- Groups ----------

// Fetch all groups by user
fastify.get("/groups", async (req, res) => {
	const userId = req.query?.userId;

	if (!userId) throw new Error("User id is required.");
	await clerkClient.users.getUser(userId);

	const usersRef = doc(firestore, "users", userId);
	const usersSnap = await getDoc(usersRef);
	const data = usersSnap.exists() ? usersSnap.data() : [];

	return res.send(data);
});

// Create new group
fastify.post("/groups", async (req, res) => {
	const { userId, groupName } = JSON.parse(await req.body);

	if (!userId) throw new Error("User id is required.");
	if (!groupName) throw new Error("Group name is required.");
	await clerkClient.users.getUser(userId);

	const groupId = uuidv4();
	const groupsRef = doc(firestore, "groups", groupId);
	const usersRef = doc(firestore, "users", userId);

	await runTransaction(firestore, async (transaction) => {
		const usersDoc = await transaction.get(usersRef);
		if (!usersDoc.exists())
			transaction.set(usersRef, {
				id: userId,
				groups: [],
			});

		transaction.set(groupsRef, {
			id: groupId,
			userId,
			name: groupName,
			messages: [],
			members: [`${userId}`],
		});
		transaction.update(usersRef, {
			groups: arrayUnion({ id: groupId, name: groupName }),
		});
	});

	return res.send({ userId, groupId, groupName });
});

// Update group - Join group, add new member to group
fastify.patch("/groups", async (req, res) => {
	const { userId, groupId } = JSON.parse(await req.body);

	// To authenticate user
	if (!userId) return res.code(400).send("User id is required.");
	if (!groupId) return res.code(400).send("Group id is required.");
	await clerkClient.users.getUser(userId);

	// To check group exist or not
	const usersRef = doc(firestore, "users", userId);
	const groupRef = doc(firestore, "groups", groupId);
	const groupSnap = await getDoc(groupRef);
	if (!groupSnap.exists()) return res.code(404).send("Group does not exist.");
	const data = groupSnap.data();

	// Update group members
	await runTransaction(firestore, async (transaction) => {
		const usersDoc = await transaction.get(usersRef);
		if (!usersDoc.exists())
			transaction.set(usersRef, {
				id: userId,
				groups: [],
			});

		transaction.update(usersRef, {
			groups: arrayUnion({ id: data.id, name: data.name }),
		});
		transaction.update(groupRef, { members: arrayUnion(userId) });
	});

	// Return group data
	return res.send(data);
});

//
// ---------- Server ----------
fastify.listen({ port: process.env.PORT }, (err, address) => {
	if (err) {
		fastify.log.error(err);
		process.exit(1);
	}
});
