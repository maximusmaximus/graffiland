# GRAFFILAND Encrypted Location Chat Boards (Server-Blind E2EE Architecture)

Each physical GRAFFILAND 3D sculpture hosts a location-locked **Encrypted Chat Board**.  
Only a person standing physically at the sculpture who views it through their smartphone's live AR camera and taps the 3D sculpture mesh can enter the board, read past chat history, and post messages.

**Core Security Invariant:** **Even the GRAFFILAND server (Cloudflare Worker, D1 database, Node/SQLite server, or IPFS storage) can NEVER decrypt or read the plaintext messages or past chat history of any sculpture chat board.**

---

## 1. Threat Model & Why Naive GPS Encryption Is Broken

A common mistake in "location-based encryption" is deriving the room encryption key directly from database coordinates (`K = KDF(lat, lng, parcelId)`). That fails under an honest-but-curious or compromised server model because:

1. The server stores `(lat, lng, altitude, parcel_id, voxels_json)` so maps and 3D previews know where to render sculptures.
2. Therefore, any key derivable *solely* from stored coordinates can also be recomputed by the server or anyone scraping public coordinates.

To guarantee **true server-blindness** while still letting physically present visitors read **past chat history**, GRAFFILAND uses a **Hybrid Zero-Server-Knowledge Architecture** combining:

1. **Client-Side Random Symmetric Room Keys (`AES-256-GCM`)** — generated on the phone (`crypto.getRandomValues(32)`), stored only locally (`localStorage`) or wrapped via client asymmetric keys. Neither `K_room` nor message plaintext ever leaves client devices.
2. **Physical Camera Selection Gate (Proof of Camera Sight)** — server-side proximity (`<= 75m`), elevation tolerance (`<= 65m`), live active rear camera (`cameraFrames >= 2`), gyroscope optical-flow telemetry, Three.js frustum visibility, and direct 3D raycast tap hit.
3. **Hybrid Key Distribution**:
   - **Peer / Creator ECDH Key-Wrapping (`ECDH P-256` + `HKDF-SHA256` + `AES-256-GCM` + `ECDSA P-256`)**: 100% server-blind cryptographic key exchange.
   - **Optional On-Site Visual Clue (`PBKDF2-SHA256`, 210,000 iterations)**: Allows a solo visitor at any hour (even when all peers/creators are offline) to unlock `K_room` locally from something visible in the physical location.

---

## 2. Two-Gate Protection Model

### Gate A — Physical Camera Selection & Server Access Control
To retrieve encrypted ciphertext history (`POST /api/sculptures/:id/chat/enter`), request membership (`request-grant`), or post ciphertext (`messages`), the client must pass `verifyCameraSightProof` (`shared/chatPolicy.mjs`):

| Check | Requirement | Purpose |
| :--- | :--- | :--- |
| **Mobile Device Only** | `isMobile === true` or mobile `User-Agent` | Blocks desktop Map/Gallery users (`403 Forbidden`) |
| **3D AR Raycast Hit** | `selectionMethod === 'ar-camera-raycast'`, `rayHit === true`, `inFrustum === true` | Ensures the sculpture is rendered inside the camera frame and tapped |
| **Active Live Camera** | `cameraReady === true`, `cameraFrames >= 2` | Confirms live video stream telemetry from Proof of Location |
| **GPS Proximity** | Haversine distance `<= 75m` (client targets `<= 60m`) | Binds board entry to physical location (`403` otherwise) |
| **Elevation Match** | `\|viewerAlt - sculptureAlt\| <= 65m` when both exist | Prevents distant altitude spoofing across levels |
| **Signature & Freshness** | `selectedAt` within `5 minutes`, signed with `ECDSA P-256` `sightSignatureB64` | Prevents stale replay of old sight tokens |

> **Desktop Isolation:** Desktop (`MapView`, `SculptureModal`, `PairWorkbench3D`) never loads `K_room`, never calls chat unlock endpoints, and only displays a locked encrypted post count (`🔒 Camera-Locked Location Chat Board`).

---

### Gate B — Server-Blind End-to-End Encryption (`client/src/utils/chatCrypto.js`)

Even if Gate A were completely compromised or an attacker dumped the entire D1/SQLite database:

#### 1. Device Identity Keypairs (`ECDH P-256` + `ECDSA P-256`)
Each authenticated browser generates a local asymmetric pair (`ecdhPublicJwk/PrivateJwk` and `signPublicJwk/PrivateJwk`) and computes a `16-hex` SHA-256 `pubFingerprint` (`XXXX-XXXX-XXXX-XXXX`).
- Private keys live strictly in browser storage (`graffiland_e2ee_id_v1_<userId>`).
- Importantly, GRAFFILAND **never** derives chat identity keys from the server-custodial Ethereum wallet (`encrypted_wallet_json`), because the server possesses the wallet encryption key (`WALLET_ENCRYPTION_KEY`). Chat keys remain completely independent.

#### 2. Board Initialization & Blinded Room Commitment
When a sculpture publishes (or the first physical viewer initializes an older sculpture's board):
1. Phone generates `K_room` (`256-bit` CSPRNG key).
2. Phone computes:
   - `roomProofToken = HMAC-SHA256(K_room, "graffiland:room-commit:" + sculptureId + ":" + keyEpoch)`
   - `roomKeyCommit = SHA-256(roomProofToken)`
3. Phone wraps `K_room` to itself (`selfGrantEnvelope`) and sends `{ ownerEcdhPubJwk, ownerSignPubJwk, ownerPubFp, selfGrantEnvelope, selfGrantSig, roomKeyCommit, [optional cluePrompt, clueWrappedJson] }` to `POST /api/sculptures/:id/chat/init`.
4. The server verifies `owner*PubJwk` strips any accidental private key (`d`) field and stores **zero plaintext**.

#### 3. Path 1: Peer / Creator ECDH Key-Wrap (100% Zero-Knowledge)
When Visitor B physically taps the sculpture through their AR camera and lacks `K_room`:
1. Visitor B's phone sends their `ECDH P-256` public key, `ECDSA P-256` verifying key, `pubFingerprint`, and live `sightProof` to `POST /api/sculptures/:id/chat/request-grant` (creating a `pending` grant row).
2. Any admitted member (the sculpture creator or any past visitor whose device holds `K_room`) fetches pending requests (`GET /api/chat/pending-grants`), checks `sightDistanceM <= 75 && sightScore >= 45`, and wraps `K_room` on their device:
   - Generates a **fresh ephemeral `ECDH P-256` keypair** `(ephPriv, ephPub)` per grant for per-delivery forward secrecy.
   - `sharedBits = ECDH(ephPriv, VisitorB.ecdhPub)`
   - `K_wrap = HKDF-SHA256(sharedBits, salt = "graffiland-ecdh-wrap-v1:" + sculptureId + ":" + keyEpoch, info = VisitorB.pubFp)`
   - `ciphertext = AES-256-GCM(K_wrap, iv, K_room, aad = sculptureId + "|" + keyEpoch + "|" + VisitorB.pubFp)`
   - `grantSig = ECDSA-SHA256(Grantor.signPriv, sculptureId|keyEpoch|VisitorB.pubFp|ephPub.x|ephPub.y|iv|ciphertext)`
3. The wrapped envelope is stored in `sculpture_chat_grants`.
4. Visitor B verifies `grantSig`, unwraps `K_room` via `ECDH`, saves `K_room` locally, and **decrypts the entire past chat history** cleanly on their phone.
5. Now holding `K_room`, Visitor B can also automatically approve future physical visitors!

#### 4. Path 2: Optional On-Site Visual Clue (`PBKDF2-SHA256`)
If the creator wants solo visitors to unlock history 24/7 with zero peers online:
1. Creator sets an on-site question visible only when physically looking around that location (e.g., `"Word on the steel bridge plaque?"`).
2. **Client-side only** (the answer is rejected if ever sent to the server):
   - Normalized answer: `answer.trim().toLowerCase().replace(/\s+/g, ' ')`
   - `K_clue = PBKDF2-SHA256(normalizedAnswer, salt = "graffiland:clue:v1:" + sculptureId + ":" + keyEpoch, iterations = 210000)`
   - `clueWrappedJson = AES-256-GCM(K_clue, iv, K_room, aad = sculptureId + "|" + keyEpoch + "|clue")`
3. When a future viewer at the location answers the prompt correctly in the AR chat modal, `PBKDF2` unwraps `K_room` locally on their phone.
4. To join the peer grantor group without revealing the clue answer or `K_room`, the viewer computes `roomProofToken` locally and sends it to `POST /api/sculptures/:id/chat/claim-grant`. The server confirms `SHA-256(roomProofToken) === board.room_key_commit` and promotes them to `status = 'granted'`.
   - *Security Note on Clues:* Strong site-specific clues protect against guessing; if ultra-high security against offline dictionary guesses by someone holding `clueWrappedJson` is desired, creators can leave `cluePrompt` empty so access operates strictly via Peer/Creator ECDH Key-Wrap.

#### 5. Encrypted Message Format & Anti-Tampering (`AES-256-GCM` + `ECDSA` + `AAD`)
Before `POST /api/sculptures/:id/chat/messages`:
- Server **explicitly rejects** any request body containing plaintext keys (`text`, `message`, `body`, `plaintext` -> `400 Bad Request`).
- Client builds JSON payload `{ v: 1, text, authorName, sightDistM, altM, sentAt }` (even author display names stay inside the encrypted ciphertext!).
- Client binds **Additional Authenticated Data (AAD)**: `{ sculptureId, keyEpoch, senderSub, senderPubFp, clientMsgId }`.
- Client encrypts payload with `K_room` (`AES-256-GCM`, random 96-bit IV, 128-bit auth tag).
- Client signs `${sculptureId}|${keyEpoch}|${senderPubFp}|${ivB64}|${ciphertextB64}|${aadJson}` with `identity.signPrivateKey` (`ECDSA P-256`).
- Receivers verify the `ECDSA` signature, validate `AAD` room/epoch/sender fields, and decrypt `AES-256-GCM` locally. If the server tampers with ciphertext, swaps messages across sculptures, or alters `sender_sub`, decryption and signature checks immediately fail.

---

## 3. Database Tables (`worker/schema.sql` & `server/db.mjs`)

- `sculpture_chat_boards`: `sculpture_id`, `creator_sub`, `key_epoch`, `room_key_commit`, `clue_prompt`, `clue_wrapped_json`, `auto_grant_pol`, timestamps.
- `sculpture_chat_grants`: `id`, `sculpture_id`, `key_epoch`, `requester_sub`, `requester_name`, `requester_ecdh_pub_jwk`, `requester_sign_pub_jwk`, `requester_pub_fp`, `sight_proof_json`, `sight_score`, `sight_distance_m`, `status`, `grantor_*`, `wrapped_key_json`, `grant_sig`, timestamps.
- `sculpture_chat_messages`: `id`, `sculpture_id`, `key_epoch`, `sender_sub`, `sender_pub_fp`, `sender_sign_pub_jwk`, `iv_b64`, `ciphertext_b64`, `aad_json`, `signature_b64`, `created_at`.

Notice there are **zero** plaintext text, body, or symmetric room-key columns in any database table.

---

## 4. API Endpoints (`shared/chatService.mjs`)

- `POST /api/sculptures/:id/chat/init` — Creator (or first physical viewer on legacy sculptures) registers board commitment & self-grant envelope.
- `POST /api/sculptures/:id/chat/clue` — Creator updates optional client-wrapped on-site visual clue blob.
- `POST /api/sculptures/:id/chat/enter` — Enforces mobile + live AR camera raycast PoL; returns wrapped grant status, clue prompt/blob, and encrypted ciphertext history.
- `POST /api/sculptures/:id/chat/request-grant` — Registers pending viewer `ECDH` pubkey + signed sight proof.
- `POST /api/sculptures/:id/chat/claim-grant` — Promotes clue-unlocked viewer via double-hashed `roomProofToken` verification.
- `GET /api/chat/pending-grants` — Lists verified physical sight requests awaiting ECDH key-wrap for boards held by caller.
- `GET /api/sculptures/:id/chat/pending-grants` — Same per-sculpture pending list for admitted members.
- `POST /api/sculptures/:id/chat/grants` — Submits ephemeral `ECDH + AES-GCM` wrapped room key + `ECDSA` signature for a pending viewer.
- `POST /api/sculptures/:id/chat/messages` — Persists `AES-256-GCM` + `ECDSA` ciphertext payload (rejects any plaintext fields).
