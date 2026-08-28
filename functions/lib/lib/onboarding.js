"use strict";
/**
 * onboarding.ts
 * -------------
 * Allt en ny användare går igenom EN gång: skapa familjen (teamet),
 * bjuda in andra föräldern, lägga till barn och sätta upp den fasta
 * cykeln (t.ex. 2/2/3) för varje barn.
 *
 * Precis som i shiftRequests.ts hålls Firestore-anropen bakom ett
 * litet interface, så filen kan testas utan en riktig Firebase-app.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.CYCLE_PRESET_LIST = void 0;
exports.createTeam = createTeam;
exports.createParentInvite = createParentInvite;
exports.acceptParentInvite = acceptParentInvite;
exports.addChild = addChild;
exports.validateCustodyCycleBlocks = validateCustodyCycleBlocks;
exports.setupCustodyCycle = setupCustodyCycle;
exports.blocksFromPattern = blocksFromPattern;
exports.generateInviteCode = generateInviteCode;
// ---------------------------------------------------------------------------
// Steg 1: skapa familjen
// ---------------------------------------------------------------------------
async function createTeam(db, args) {
    const teamId = await db.createTeam({
        name: args.teamName,
        parentIds: [args.creatorUid],
        parentProfiles: { [args.creatorUid]: args.creatorProfile },
        childIds: [],
        createdAt: nowTs(),
        createdBy: args.creatorUid,
    });
    await db.updateUser(args.creatorUid, { teamId });
    return teamId;
}
// ---------------------------------------------------------------------------
// Steg 2: bjud in andra föräldern
// ---------------------------------------------------------------------------
const INVITE_TTL_HOURS = 72;
async function createParentInvite(db, teamId, 
/** Appens publika adress, t.ex. "https://ert-projekt.web.app". */
baseUrl) {
    const code = generateInviteCode();
    const expiresAt = new Date(Date.now() + INVITE_TTL_HOURS * 60 * 60 * 1000);
    await db.createInvite(teamId, code, expiresAt);
    return {
        code,
        expiresAt,
        shareUrl: `${baseUrl.replace(/\/$/, "")}/join/${encodeURIComponent(code)}`,
    };
}
/**
 * Körs när förälder 2 klickar på inbjudningslänken och är inloggad.
 *
 * Kontrollerar att teamet inte redan är fullt: ett team är avsett för
 * exakt två föräldrar, och utan den kontrollen kunde en tredje person
 * med en läckt kod ansluta och läsa barnens personnummer.
 */
async function acceptParentInvite(db, args) {
    const peeked = await db.peekInvite(args.code);
    if (!peeked)
        return { error: "invalid_or_expired" };
    const team = await db.getTeam(peeked.teamId);
    if (!team)
        return { error: "invalid_or_expired" };
    if (team.parentIds.includes(args.uid)) {
        // Redan medlem — konsumera inte koden, bara släpp in personen.
        return { teamId: peeked.teamId };
    }
    if (team.parentIds.length >= 2) {
        return { error: "team_full" };
    }
    // Konsumera koden först nu, när vi vet att anslutningen kan gå igenom.
    const consumed = await db.consumeInvite(args.code);
    if (!consumed)
        return { error: "invalid_or_expired" };
    await db.addParentToTeam(consumed.teamId, args.uid, args.profile);
    await db.updateUser(args.uid, { teamId: consumed.teamId });
    return { teamId: consumed.teamId };
}
// ---------------------------------------------------------------------------
// Steg 3: lägg till barn
// ---------------------------------------------------------------------------
async function addChild(db, args) {
    const childId = await db.createChild({
        teamId: args.teamId,
        name: args.name,
        birthYear: args.birthYear,
        createdAt: nowTs(),
    });
    return childId;
}
function validateCustodyCycleBlocks(blocks) {
    if (blocks.length === 0)
        return "Cykeln måste ha minst ett block.";
    if (blocks.some((b) => b.days <= 0 || !Number.isInteger(b.days))) {
        return "Varje block måste vara ett helt antal dagar (minst 1).";
    }
    const parentIds = new Set(blocks.map((b) => b.parentId));
    if (parentIds.size < 2) {
        return "Cykeln bör innehålla båda föräldrarna — annars behövs inget schema.";
    }
    return null;
}
async function setupCustodyCycle(db, input) {
    const validationError = validateCustodyCycleBlocks(input.blocks);
    if (validationError)
        throw new Error(validationError);
    await db.writeCustodyCycle(input.teamId, input.childId, {
        childId: input.childId,
        blocks: input.blocks,
        cycleStartDate: input.cycleStartDate,
        switchHour: input.switchHour,
        timezone: input.timezone,
        updatedAt: nowTs(),
        updatedBy: input.updatedBy,
    });
    await db.initDayBalance(input.teamId, input.childId, {
        childId: input.childId,
        balanceDays: 0,
        referenceParentId: input.referenceParentId,
        updatedAt: nowTs(),
    });
}
/** Vanliga färdiga mönster att erbjuda i UI:t, så man slipper bygga från noll. */
exports.CYCLE_PRESET_LIST = [
    { label: "Varannan vecka (7/7)", pattern: [7, 7] },
    { label: "2-2-3", pattern: [2, 2, 3, 2, 2, 3] },
    { label: "2-2-5-5", pattern: [2, 2, 5, 5] },
    { label: "3-4-4-3", pattern: [3, 4, 4, 3] },
];
/** Bygger blocks[] från ett mönster + vilken förälder som börjar. */
function blocksFromPattern(pattern, firstParentId, secondParentId) {
    return pattern.map((days, i) => ({
        parentId: i % 2 === 0 ? firstParentId : secondParentId,
        days,
    }));
}
// ---------------------------------------------------------------------------
// Hjälpfunktioner
// ---------------------------------------------------------------------------
/**
 * Inbjudningskoden är i praktiken en nyckel till familjens ALLA uppgifter
 * — inklusive barnens personnummer. Därför:
 *
 *  - 10 tecken ur ett 31-teckens alfabet (~10^15 kombinationer) istället
 *    för 6 (~10^9, vilket är gissningsbart med automatik).
 *  - Kryptografiskt säker slump, inte Math.random() (som är förutsägbar
 *    om man sett tidigare värden).
 *  - Grupperas som ABCDE-FGHIJ för att vara läsbar att skriva av.
 *
 * Servern begränsar dessutom antal försök, se acceptInvite i functions.
 */
const INVITE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // utan I, L, O, 0, 1
const INVITE_CODE_LENGTH = 10;
function randomBytes(count) {
    const bytes = new Uint8Array(count);
    const cryptoObj = (typeof globalThis !== "undefined" && globalThis.crypto) || undefined;
    if (cryptoObj?.getRandomValues) {
        cryptoObj.getRandomValues(bytes);
        return bytes;
    }
    // Node utan global crypto (äldre runtimes)
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const nodeCrypto = require("crypto");
    return new Uint8Array(nodeCrypto.randomBytes(count));
}
function generateInviteCode() {
    // Avvisa värden i det sista ofullständiga intervallet, så fördelningen
    // över alfabetet blir jämn (modulo-bias undviks).
    const limit = 256 - (256 % INVITE_ALPHABET.length);
    const chars = [];
    while (chars.length < INVITE_CODE_LENGTH) {
        for (const byte of randomBytes(INVITE_CODE_LENGTH)) {
            if (byte < limit) {
                chars.push(INVITE_ALPHABET[byte % INVITE_ALPHABET.length]);
                if (chars.length === INVITE_CODE_LENGTH)
                    break;
            }
        }
    }
    const code = chars.join("");
    return `${code.slice(0, 5)}-${code.slice(5)}`;
}
function toTs(date) {
    const ms = date.getTime();
    return { seconds: Math.floor(ms / 1000), nanoseconds: (ms % 1000) * 1e6 };
}
function nowTs() {
    return toTs(new Date());
}
