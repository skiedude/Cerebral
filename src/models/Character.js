'use strict';

import Store from 'electron-store';

import EsiClient from '../helpers/eve/EsiClient';
import TypeHelper from '../helpers/TypeHelper';
import StationHelper from '../helpers/StationHelper';
import StructureHelper from '../helpers/StructureHelper';
import SystemHelper from '../helpers/SystemHelper';
import AuthorizedCharacter from './AuthorizedCharacter';

import appProperties from '../../resources/properties';
import alphaSkillSet from '../../resources/alpha_skill_set';
import DateTimeHelper from '../helpers/DateTimeHelper';
import BulkIdResolver from '../helpers/BulkIdResolver';
import LocationHelper from '../helpers/LocationHelper';
import MailBodyHelper from '../helpers/MailBodyHelper';

let subscribedComponents = [];
let characters;
const charactersStore = new Store({
    name: 'character-data'
});
let charactersSaveTimeout;

class Character {
    constructor(id, name) {
        if (id !== undefined) {
            id = id.toString();
            this.id = id;
        }

        this.name = name;
        this.skills = [];
        this.skillQueue = [];
        this.skillTree = [];
        this.nextRefreshes = {};
        this.contractSlotsUsed = 0;
        this.mails = [];
        this.mailLabels = {};
        this.mailingLists = {};
    }

    getCurrentSkill() {
        const currentDate = new Date();

        for (let o of this.skillQueue) {
            if ((o.hasOwnProperty('finish_date')) && (new Date(o.finish_date) > currentDate)) {
                return o;
            }
        }

        return undefined;
    }

    getFinishedSkillsInQueue() {
        const currentDate = new Date();

        return this.skillQueue.filter((o) => {
            return (o.hasOwnProperty('finish_date')) && (new Date(o.finish_date) < currentDate);
        });
    }

    getMails() {
        return this.mails
    }

    getMailLabels() {
        return this.mailLabels
    }

    getLastSkill() {
        let lastDate = new Date();
        let lastSkill = undefined;

        for (let o of this.skillQueue) {
            if ((o.hasOwnProperty('finish_date')) && (new Date(o.finish_date) > lastDate)) {
                lastSkill = o;
                lastDate = new Date(o.finish_date);
            }
        }

        return lastSkill;
    }

    getCurrentSpPerMillisecond() {
        let currentSkill = this.getCurrentSkill();
        if (currentSkill === undefined) {
            return 0;
        }

        let startingSp = currentSkill.training_start_sp;
        let startingMilliseconds = new Date(currentSkill.start_date).getTime();
        let endingSp = currentSkill.level_end_sp;
        let endingMilliseconds = new Date(currentSkill.finish_date).getTime();
        return (endingSp - startingSp) / (endingMilliseconds - startingMilliseconds);
    }

    getCurrentSpPerHour() {
        return Math.round(this.getCurrentSpPerMillisecond() * 1000 * 3600);
    }

    getMaxSpPerHour() {
        // Assuming best remap and Omega with +5s or Alpha with +3s
        return this.isOmega() ? 2700 : 1260;
    }

    getInjectorsReady(baseSp) {
        if (baseSp === undefined) {
            baseSp = 5000000;
        }

        return Math.max(0, Math.floor((this.getTotalSp() - baseSp) / 500000));
    }

    getNextInjectorDate(baseSp) {
        if (baseSp === undefined) {
            baseSp = 5000000;
        }

        const currentSp = this.getTotalSp();
        const nextInjectorTotalSp = baseSp + ((this.getInjectorsReady(baseSp) + 1) * 500000);

        const spNeeded = nextInjectorTotalSp - currentSp;
        const millisecondsToTrainSp = spNeeded / this.getCurrentSpPerMillisecond();

        return isFinite(millisecondsToTrainSp) ? new Date(new Date().getTime() + millisecondsToTrainSp) : undefined;
    }

    /**
     * Determining total SP is quite challenging. This is the method:
     *
     *  * Iterate over all skills the character has
     *  * If a skill is the currently training skill, we completely ignore the skillpoints_in_skill which CCP gives us.
     *    Instead, we use the training_start_sp figure from the queue, and then add on the projected SP which the
     *    character will have trained since the start_date.
     *  * Else if a skill is in the queue at least once listed as finished, we start with the skillpoints_in_skill
     *    figure for the skill. We then add on the difference between the end and start sp for each finished level of
     *    the skill in the queue.
     *  * Else, the skill is not in any way in the queue, and we can simply use the skillpoints_in_skill figure
     *
     * Note that this will NOT be accurate if the character is currently using a cerebral accelerator (boosters are not
     * shown in the API).
     *
     * @returns int projected character sp at this moment in time
     */
    getTotalSp() {
        let totalSp = 0;

        let currentSkill = this.getCurrentSkill();
        if (currentSkill === undefined) {
            return this.total_sp;
        }

        const finishedSkills = this.getFinishedSkillsInQueue();
        const finishedSkillIds = finishedSkills.map(o => o.skill_id);
        for (let skill of this.skills) {
            if (skill.skill_id === currentSkill.skill_id) {
                let startingMilliseconds = new Date(currentSkill.start_date).getTime();
                let millisecondsPassed = new Date().getTime() - startingMilliseconds;
                let additionalTrainedSp = millisecondsPassed * this.getCurrentSpPerMillisecond();
                totalSp += (currentSkill.training_start_sp + additionalTrainedSp);
            } else if (finishedSkillIds.includes(skill.skill_id)) {
                const queueEntries = finishedSkills.filter(o => o.skill_id === skill.skill_id);

                for (let queueEntry of queueEntries) {
                    totalSp += (queueEntry.level_end_sp - queueEntry.training_start_sp);
                }

                totalSp += skill.skillpoints_in_skill;
            } else {
                totalSp += skill.skillpoints_in_skill;
            }
        }

        return Math.floor(totalSp);
    }

    isOmega() {
        // if they have >5 mil sp and a skill actively training, must be omega
        if ((this.total_sp > 5000000) && (this.getCurrentSkill() != null)) {
            return true;
        }

        // if they have any skills with trained level > active, must be alpha
        if (this.skills.find(o => o.trained_skill_level > o.active_skill_level) !== undefined) {
            return false;
        }

        // if they have any skills with a higher active level than the maximum alpha level, must be omega

        if (this.skills.find(o => o.active_skill_level > 0 &&
                (!alphaSkillSet.hasOwnProperty(o.skill_name) ||
                    o.active_skill_level > alphaSkillSet[o.skill_name]
                )
            ) !== undefined) {
            return true;
        }

        // if they have any skills starting >24 hours in the future with a scheduled finish date, must be omega
        if (this.skills.find(o =>
                (new Date(o.start_date).getTime()) > (new Date().getTime() + 24 * 60 * 60) &&
                o.hasOwnProperty('finish_date')
            ) !== undefined) {
            return true;
        }

        // no definitive answer
        return undefined;
    }

    getFatigueInfo() {
        if ((this.fatigue === undefined) || (this.fatigue.last_jump_date === undefined)) {
            return undefined;
        }

        const lastJumpDate = new Date(this.fatigue.last_jump_date);
        const blueTimerExpiryDate = new Date(this.fatigue.jump_fatigue_expire_date);
        const redTimerExpiryDate = new Date(this.fatigue.last_update_date);
        const curDate = new Date();

        return {
            last_jump: {
                date: lastJumpDate,
                relative: `${DateTimeHelper.timeSince(lastJumpDate)} ago `,
            },

            blue_timer_expiry: {
                date: blueTimerExpiryDate,
                relative: (blueTimerExpiryDate > curDate) ? DateTimeHelper.timeUntil(blueTimerExpiryDate) : 'None',
            },

            red_timer_expiry: {
                date: redTimerExpiryDate,
                relative: (redTimerExpiryDate > curDate) ? DateTimeHelper.timeUntil(redTimerExpiryDate) : 'None',
            },
        };
    }

    getCloneJumpAvailable() {
        const synchro = this.skills.find(o => o.skill_name === 'Infomorph Synchronizing');
        const millisecReduction = (synchro !== undefined) ? synchro.active_skill_level * 3600 * 1000 : 0;

        const lastJumpDate = new Date(this.last_clone_jump_date);
        const nextJumpDate = new Date(lastJumpDate.getTime() + (24 * 3600 * 1000) - millisecReduction);

        return {
            date: nextJumpDate,
            relative: (nextJumpDate > new Date()) ? DateTimeHelper.timeUntil(nextJumpDate) : 'Now'
        };
    }

    getMaxClones() {
        const psycho = this.skills.find(o => o.skill_name === 'Infomorph Psychology');
        const advPsycho = this.skills.find(o => o.skill_name === 'Advanced Infomorph Psychology');

        if (advPsycho !== undefined) {
            return psycho.active_skill_level + advPsycho.active_skill_level;
        } else if (psycho !== undefined) {
            return psycho.active_skill_level;
        } else {
            return 0;
        }
    }

    getMaxContracts() {
        const contracting = this.skills.find(o => o.skill_name === 'Contracting');

        if (contracting !== undefined) {
            return 1 + (contracting.active_skill_level * 4)
        } else {
            return 1;
        }
    }

    buildSkillTree() {
        let groups = {};

        for (const skill of this.skills) {
            if (!groups.hasOwnProperty(skill.skill_group_name)) {
                groups[skill.skill_group_name] = [];
            }

            groups[skill.skill_group_name].push(skill);
        }

        let groupsArray = [];
        for (const groupName in groups) {
            if (groups.hasOwnProperty(groupName)) {
                let skills = groups[groupName];
                skills.sort((a, b) => a.skill_name.localeCompare(b.skill_name));

                groupsArray.push({
                    name: groupName,
                    skills: skills,
                    total_sp: skills.reduce((total, skill) => total + skill.skillpoints_in_skill, 0)
                });
            }
        }

        groupsArray.sort((a, b) => a.name.localeCompare(b.name));

        this.skillTree = groupsArray;
    }

    async refreshAll() {
        // first refresh basic info which will be needed for the rest of the calls
        await this.refreshInfo();

        // refresh access token if needed, enforce 60 second validity to prevent chance of a mid data pull refresh
        await AuthorizedCharacter.get(this.id).getAccessToken(60);

        // asynchronously fetch all the other information and return a promise which resolves when everything is fetched
        return Promise.all([
            this.refreshPortrait(),
            this.refreshSkills(),
            this.refreshSkillQueue(),
            this.refreshAttributes(),
            this.refreshCorporation(),
            this.refreshAlliance(),
            this.refreshWallet(),
            this.refreshImplants(),
            this.refreshJumpClones(),
            this.refreshLocation(),
            this.refreshShip(),
            this.refreshFatigue(),
            this.refreshLoyaltyPoints(),
            this.refreshContracts(),
            this.refreshMails(),
            this.refreshMailLabels(),
            this.refreshMailingLists(),
        ]);
    }

    getDateOfBirth() {
        return new Date(this.birthday);
    }

    getNextYearlyRemapDate() {
        const remapAvailable = new Date(this.attributes.accrued_remap_cooldown_date);
        return remapAvailable > new Date() ? remapAvailable : true;
    }

    async refreshInfo() {
        if (this.shouldRefresh('character_info')) {
            let client = new EsiClient();
            let charData = await client.get('characters/' + this.id, 'v4');
            Object.assign(this, charData);
            this.save();
            this.markRefreshed('character_info');
        }
    }

    async refreshPortrait() {
        if (this.shouldRefresh('portrait')) {
            let client = new EsiClient();
            this.portraits = await client.get('characters/' + this.id + '/portrait', 'v2');
            this.save();
            this.markRefreshed('portrait');
        }
    }

    async refreshCorporation() {
        if (this.shouldRefresh('corporation')) {
            let client = new EsiClient();
            this.corporation = await client.get('corporations/' + this.corporation_id, 'v4');
            this.save();
            this.markRefreshed('corporation');
        }
    }

    async refreshAlliance() {
        if (this.shouldRefresh('alliance')) {
            if (this.alliance_id !== undefined) {
                let client = new EsiClient();
                this.alliance = await client.get('alliances/' + this.alliance_id, 'v3');
                this.save();
                this.markRefreshed('alliance');
            }
        }
    }

    async refreshSkills() {
        if (this.shouldRefresh('skills')) {
            let client = new EsiClient();
            await client.authChar(AuthorizedCharacter.get(this.id));

            let skillData = await client.get('characters/' + this.id + '/skills', 'v4');
            Object.assign(this, skillData);
            if (!skillData.hasOwnProperty('unallocated_sp')) {
                this.unallocated_sp = 0;
            }

            const spRequirements = {};
            spRequirements[0] = [0];
            for (const a of[1, 2, 3, 4, 5]) {
                spRequirements[a] = [];
                for (const b of[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]) {
                    const x = Math.round(250 * b * Math.pow(Math.sqrt(32), a - 1));
                    spRequirements[a].push(x);
                    spRequirements[a].push(x + 1);
                }
            }

            let promises = this.skills.map((o) => {
                return TypeHelper.resolveType(o.skill_id).then(res => {
                    o.skill_name = res.name;
                    o.skill_group_name = res.group.name;
                    o.half_trained = !spRequirements[parseInt(o.trained_skill_level)].includes(o.skillpoints_in_skill);
                    return o;
                });
            });

            await Promise.all(promises);

            this.buildSkillTree();

            this.save();
            this.markRefreshed('skills');
        }
    }

    async refreshSkillQueue() {
        if (this.shouldRefresh('skill_queue')) {
            let client = new EsiClient();
            await client.authChar(AuthorizedCharacter.get(this.id));

            this.skillQueue = await client.get('characters/' + this.id + '/skillqueue', 'v2');

            let promises = this.skillQueue.map((o) => {
                return TypeHelper.resolveType(o.skill_id).then(res => {
                    o.skill_name = res.name;
                    return o;
                });
            });

            await Promise.all(promises);

            this.save();
            this.markRefreshed('skill_queue');
        }
    }

    async refreshAttributes() {
        if (this.shouldRefresh('attributes')) {
            let client = new EsiClient();
            await client.authChar(AuthorizedCharacter.get(this.id));

            this.attributes = await client.get('characters/' + this.id + '/attributes', 'v1');
            this.save();
            this.markRefreshed('attributes');
        }
    }

    async refreshImplants() {
        if (this.shouldRefresh('implants')) {
            let client = new EsiClient();
            await client.authChar(AuthorizedCharacter.get(this.id));

            let implantIds = await client.get('characters/' + this.id + '/implants', 'v1');
            this.implants = [];
            for (let id of implantIds) {
                this.implants.push({ id: id });
            }

            let promises = this.implants.map((o) => {
                return TypeHelper.resolveType(o.id).then(res => {
                    o.name = res.name;
                    o.dogmaAttributes = res.dogma_attributes;
                    return o;
                });
            });

            await Promise.all(promises);

            this.save();
            this.markRefreshed('implants');
        }
    }

    async refreshJumpClones() {
        if (this.shouldRefresh('clones')) {
            let client = new EsiClient();
            await client.authChar(AuthorizedCharacter.get(this.id));

            let cloneData = await client.get('characters/' + this.id + '/clones', 'v3');

            // last jump
            this.last_clone_jump_date = cloneData.last_clone_jump_date;

            // home location
            this.home_location = cloneData.home_location;
            if (this.home_location.location_type === 'station') {
                const station = await StationHelper.resolveStation(this.home_location.location_id);
                delete station.system.planets;
                this.home_location.location = station;
            } else if (this.home_location.location_type === 'structure') {
                const structure = await StructureHelper.resolveStructure(this.home_location.location_id, client, this.id);
                if (structure !== undefined) {
                    delete structure.system.planets;
                    this.home_location.location = structure;
                }
            }

            // general jump clone data + resolve implant names/dogma attributes in the clones
            let promises = [];
            this.jumpClones = [];
            for (let jumpCloneData of cloneData.jump_clones) {
                let jumpClone = {};

                jumpClone.implants = [];
                for (let id of jumpCloneData.implants) {
                    jumpClone.implants.push({ id: id });
                }

                Array.prototype.push.apply(promises, jumpClone.implants.map((o) => {
                    return TypeHelper.resolveType(o.id).then(res => {
                        o.name = res.name;
                        o.dogmaAttributes = res.dogma_attributes;
                        return o;
                    });
                }));

                delete jumpCloneData.implants;
                Object.assign(jumpClone, jumpCloneData);

                this.jumpClones.push(jumpClone);
            }

            // resolve locations
            const that = this;
            Array.prototype.push.apply(promises, this.jumpClones.map((o) => {
                if (o.location_type === "station") {
                    return StationHelper.resolveStation(o.location_id).then(station => {
                        delete station.system.planets;
                        o.location = station;
                        return o;
                    });
                } else if (o.location_type === "structure") {
                    return StructureHelper.resolveStructure(o.location_id, client, that.id).then(structure => {
                        if (structure !== undefined) {
                            delete structure.system.planets;
                            o.location = structure;
                        }
                        return o;
                    });
                } else {
                    return Promise.resolve(undefined); // unknown location type (wtf? this won't happen, if it does, smths changed with jump clones)
                }
            }));

            await Promise.all(promises);

            this.save();
            this.markRefreshed('clones');
        }
    }

    async refreshLocation() {
        if (this.shouldRefresh('location')) {
            let client = new EsiClient();
            await client.authChar(AuthorizedCharacter.get(this.id));

            this.location = await client.get('characters/' + this.id + '/location', 'v1');

            // standardising solar_system_id --> system_id since ccp is indecisive
            this.location.system_id = this.location.solar_system_id;
            delete this.location.solar_system_id;
            this.location.system = await SystemHelper.resolveSystem(this.location.system_id);

            // lookup station/structure
            if (this.location.station_id !== undefined) {
                const station = await StationHelper.resolveStation(this.location.station_id);
                delete station.system.planets;
                this.location.location = station;
            } else if (this.location.structure_id !== undefined) {
                const structure = await StructureHelper.resolveStructure(this.location.structure_id, client, this.id);
                if (structure !== undefined) {
                    delete structure.system.planets;
                    this.location.location = structure;
                }
            }

            this.save();
            this.markRefreshed('location');
        }
    }

    async refreshShip() {
        if (this.shouldRefresh('ship')) {
            let client = new EsiClient();
            await client.authChar(AuthorizedCharacter.get(this.id));

            this.ship = await client.get('characters/' + this.id + '/ship', 'v1');
            this.ship.type = await TypeHelper.resolveType(this.ship.ship_type_id);

            this.save();
            this.markRefreshed('ship');
        }
    }

    async refreshWallet() {
        if (this.shouldRefresh('wallet')) {
            let client = new EsiClient();
            await client.authChar(AuthorizedCharacter.get(this.id));

            this.balance = await client.get('characters/' + this.id + '/wallet', 'v1');
            this.save();
            this.markRefreshed('wallet');
        }
    }

    async refreshFatigue() {
        if (this.shouldRefresh('fatigue')) {
            let client = new EsiClient();
            await client.authChar(AuthorizedCharacter.get(this.id));

            try {
                this.fatigue = await client.get('characters/' + this.id + '/fatigue', 'v1', 'esi-characters.read_fatigue.v1');
                this.markRefreshed('fatigue');
            } catch (err) {
                if (err === 'Scope missing') {
                    this.markFailedNoScope('fatigue');
                }
            }

            this.save();
        }
    }

    async refreshLoyaltyPoints() {
        if (this.shouldRefresh('loyalty_points')) {
            let client = new EsiClient();
            await client.authChar(AuthorizedCharacter.get(this.id));

            try {
                const data = await client.get('characters/' + this.id + '/loyalty/points', 'v1',
                    'esi-characters.read_loyalty.v1'
                );

                this.loyalty_points = [];
                for (let o of data) {
                    if (o.loyalty_points > 0) {
                        o.corporation = await client.get('corporations/' + o.corporation_id, 'v4');
                        this.loyalty_points.push(o);
                    }
                }

                this.loyalty_points.sort((a, b) => a.corporation.name.localeCompare(b.corporation.name));

                this.markRefreshed('loyalty_points');
            } catch (err) {
                if (err === 'Scope missing') {
                    this.markFailedNoScope('loyalty_points');
                }
            }

            this.save();
        }
    }

    async refreshContracts() {
        if (this.shouldRefresh('contracts')) {
            let client = new EsiClient();
            await client.authChar(AuthorizedCharacter.get(this.id));

            try {
                this.contracts = await client.get('characters/' + this.id + '/contracts', 'v1',
                    'esi-contracts.read_character_contracts.v1'
                );

                let resolver = new BulkIdResolver();
                this.contractSlotsUsed = 0;
                for (let contract of this.contracts) {
                    resolver.addId(contract.issuer_id);
                    resolver.addId(contract.issuer_corporation_id);
                    resolver.addId(contract.assignee_id);
                    resolver.addId(contract.acceptor_id);

                    // build used contracts value
                    if (
                        (!appProperties.contract_completed_statuses.includes(contract.status)) &&
                        (contract.issuer_id.toString() === this.id) &&
                        (contract.for_corporation === false) &&
                        (contract.availability !== 'corporation')
                    ) {
                        this.contractSlotsUsed++;
                    }
                }

                await resolver.resolve();

                for (let contract of this.contracts) {
                    contract.issuer = resolver.get(contract.issuer_id);
                    contract.issuer_corporation = resolver.get(contract.issuer_corporation_id);
                    contract.assignee = resolver.get(contract.assignee_id);
                    contract.acceptor = resolver.get(contract.acceptor_id);

                    // start+end locations
                    if (contract.start_location_id !== undefined) {
                        contract.start_location = await LocationHelper.resolveLocation(
                            contract.start_location_id, client, this.id
                        );
                    }
                    if (contract.end_location_id !== undefined) {
                        contract.end_location = await LocationHelper.resolveLocation(
                            contract.end_location_id, client, this.id
                        );
                    }
                }

                this.markRefreshed('contracts');
            } catch (err) {
                if (err === 'Scope missing') {
                    this.markFailedNoScope('contracts');
                }
            }

            this.save();
        }
    }

    async refreshMailLabels() {
        if (this.shouldRefresh('maillabels')) {
            const client = new EsiClient();
            await client.authChar(AuthorizedCharacter.get(this.id));

            try {
                const labels = await client.get('characters/' + this.id + '/mail/labels', 'v2', 'esi-mail.read_mail.v1');

                const mailLabels = {};
                for (const label of labels) {
                    mailLabels[label.label_id] = label;
                }

                this.mailLabels = mailLabels;

                this.markRefreshed('maillabels');
            } catch (err) {
                if (err === 'Scope missing') {
                    this.markFailedNoScope('mails');
                }
            }

            this.save();
        }
    }

    async refreshMailingLists() {
        if (this.shouldRefresh('mailinglists')) {
            const client = new EsiClient();
            await client.authChar(AuthorizedCharacter.get(this.id));

            try {
                const mailingLists = await client.get('characters/' + this.id + '/mail/lists', 'v1', 'esi-mail.read_mail.v1');

                const lists = {};

                for (const list of mailingLists) {
                    lists[list.mailing_list_id] = list;
                }

                this.mailingLists = lists;

                this.markRefreshed('mailinglists');
            } catch (err) {
                if (err === 'Scope missing') {
                    this.markFailedNoScope('mails');
                }
            }

            this.save();
        }
    }

    async refreshMails() {
        if (this.shouldRefresh('mails')) {
            const client = new EsiClient();
            await client.authChar(AuthorizedCharacter.get(this.id));

            try {
                this.mails = await client.get('characters/' + this.id + '/mail', 'v1', 'esi-mail.read_mail.v1');

                const resolver = new BulkIdResolver();
                for (const mail of this.mails) {
                    // "Welcome" mail from a mailing list, mailing lists will not resolve
                    if (mail.recipients[0].recipient_type === 'mailing_list' && mail.recipients[0].recipient_id == mail.from) {
                        mail.from_name = 'Welcome ML';
                    } else {
                        resolver.addId(mail.from);
                    }

                    // resolve any resolveable names
                    for (const recipient of mail.recipients) {
                        if (recipient.recipient_type !== undefined && recipient.recipient_id !== undefined) {
                            switch (recipient.recipient_type) {
                                case 'character':
                                case 'corporation':
                                case 'alliance':
                                    resolver.addId(recipient.recipient_id);
                                    break;
                                default:
                                    break;
                            }
                        }
                    }

                    const labelNames = [];
                    for (const label of mail.labels) {
                        // outbox
                        if (label === 2) {
                            this.is_sent = true;
                        }

                        if (this.mailLabels.hasOwnProperty(label)) {
                            labelNames.push(this.mailLabels[label].name);
                        }
                    }

                    mail.label_names = labelNames;
                    mail.is_sent = mail.hasOwnProperty('is_sent') ? mail.is_sent : false;
                    mail.is_read = mail.hasOwnProperty('is_read') ? mail.is_read : false;

                    mail.subject = mail.subject.replace(/&amp;/g, '&');
                    mail.subject = mail.subject.replace(/&lt;/g, '<');
                    mail.subject = mail.subject.replace(/&gt;/g, '>');
                    mail.subject = mail.subject.replace(/&quot;/g, '"');
                }

                await resolver.resolve();

                for (const mail of this.mails) {
                    if (resolver.get(mail.from) !== undefined) {
                        mail.from_name = resolver.get(mail.from).name;
                    } else if (this.mailingLists[mail.from] !== undefined) {
                        mail.from_name = this.mailingLists[mail.from].name;
                    } else {
                        mail.from_name = '*Unknown*';
                    }

                    for (const recipient of mail.recipients) {
                        if (recipient.recipient_type !== undefined && recipient.recipient_id !== undefined) {
                            switch (recipient.recipient_type) {
                                case 'character':
                                case 'corporation':
                                case 'alliance':
                                    recipient.recipient_name = resolver.get(recipient.recipient_id) !== undefined ? resolver.get(recipient.recipient_id).name : '*Unknown*';
                                    break;
                                case 'mailing_list':
                                    this.mailingLists[recipient.recipient_id] !== undefined ? recipient.recipient_name = this.mailingLists[recipient.recipient_id].name : '*Unknown Mailing List*';
                                    break;
                                default:
                                    recipient.recipient_name = '*Unknown*';
                                    break;
                            }
                        }
                    }

                    mail.body = await MailBodyHelper.retrieveMailBody(mail.mail_id, client, this.id)
                }

                this.markRefreshed('mails');
            } catch (err) {
                if (err === 'Scope missing') {
                    this.markFailedNoScope('mails');
                }
            }

            this.save();
        }
    }

    shouldRefresh(type) {
        return (!this.nextRefreshes.hasOwnProperty(type)) || (new Date(this.nextRefreshes[type].do) < new Date());
    }

    markRefreshed(type) {
        this.nextRefreshes[type] = {
            last: new Date(),
            do: new Date(new Date().getTime() + appProperties.refresh_intervals[type] * 1000)
        };
    }

    /**
     * Mark a type of data refresh as a failure and that further refresh attempts should not be attempted
     *
     * @param {string} type - data type string, e.g. skills, see properties.js
     * @param {string} reason - failure reason: 'scope', 'token', 'client', 'error'
     * @param {boolean} temporary - if true, failure is expected to only be temporary
     */
    markTypeFailed(type, reason, temporary = false) {
        this.nextRefreshes[type] = {
            last: new Date(),
            do: temporary ? new Date(new Date().getTime() + (300 * 1000)) : undefined,
            error: reason
        };
    }

    /**
     * Mark data refresh for all data types as a failure and that further refresh attempts should not be attempted
     *
     * @param {string} reason - failure reason: 'scope', 'token', 'client', 'error'
     * @param {boolean} temporary - if true, failure is expected to only be temporary
     */
    markFailed(reason, temporary = false) {
        for (const type in this.nextRefreshes) {
            if (this.nextRefreshes.hasOwnProperty(type)) {
                this.markTypeFailed(type, reason, temporary);
            }
        }
    }

    /**
     * @deprecated use markTypeFailed(type, 'scope') instead
     */
    markFailedNoScope(type) {
        this.markTypeFailed(type, 'scope');
    }

    getDataRefreshInfo() {
        let info = [];

        const translations = {
            "character_info": "Character Info",
            "attributes": "Attributes and Remaps",
            "loyalty_points": "Loyalty Points",
            "wallet": "Wallet",
            "implants": "Active Implants",
            "clones": "Jump Clones",
            "skills": "Skills",
            "skill_queue": "Skill Queue",
            "contracts": "Contracts",
            "location": "Current Location",
            "ship": "Active Ship",
            "fatigue": "Jump Fatigue",
            "mails": "Mails",
            "maillabels": "Mail Labels",
            "mailinglists": "Mailing Lists",
        };

        // TODO: clean this up jfc
        for (const key in translations) {
            if ((this.nextRefreshes.hasOwnProperty(key)) && (translations.hasOwnProperty(key))) {
                let las;
                if (this.nextRefreshes[key].error === undefined) {
                    const lastDate = new Date(this.nextRefreshes[key].last);
                    las = (lastDate.getTime() + 5000 < new Date().getTime()) ?
                        DateTimeHelper.timeSince(lastDate) + " ago" : "Just now";
                } else {
                    switch (this.nextRefreshes[key].error) {
                        case 'scope':
                            las = 'No Scope';
                            break;
                        case 'token':
                            las = 'Token Invalid';
                            break;
                        case 'client':
                            las = 'Client Invalid';
                            break;
                        default:
                            las = 'Error';
                    }
                }

                let nex;
                if (this.nextRefreshes[key].do !== undefined) {
                    const nextDate = new Date(this.nextRefreshes[key].do);
                    nex = (nextDate > new Date()) ? DateTimeHelper.timeUntil(nextDate) : "Due";
                } else {
                    nex = 'Never';
                }

                info.push({
                    type: translations[key],
                    lastRefresh: las,
                    nextRefresh: nex
                });
            }
        }

        return info;
    }

    static markCharacterForForceRefresh(characterId) {
        characterId = characterId.toString();

        if (characters.hasOwnProperty(characterId)) {
            let character = characters[characterId];
            for (const key in character.nextRefreshes) {
                if (character.nextRefreshes.hasOwnProperty(key)) {
                    character.nextRefreshes[key].do = new Date();
                    character.save();
                }
            }
        }
    }

    static async build() {
        Character.suspendSubscribers();

        let authorizedChars = AuthorizedCharacter.getAll();

        let promises = [];
        Object.keys(authorizedChars).map(id => {
            if (characters.hasOwnProperty(id)) {
                promises.push(characters[id].refreshAll());
            } else {
                let char = new Character(id);
                promises.push(char.refreshAll());
                characters[id] = char;
            }
        });

        try {
            await Promise.all(promises);
        } catch (err) {}

        Character.pushToSubscribers();
    }

    static getAll() {
        return characters;
    }

    static getAllContracts(complete) {
        let contracts = [];
        let contractIds = [];

        for (const id in characters) {
            if (characters.hasOwnProperty(id)) {
                if (characters[id].hasOwnProperty('contracts') && characters[id].contracts !== undefined) {
                    for (const contract of characters[id].contracts) {
                        if (complete !== undefined) {
                            if ((complete === true) && (!appProperties.contract_completed_statuses.includes(contract.status))) {
                                continue;
                            } else if ((complete === false) && (appProperties.contract_completed_statuses.includes(contract.status))) {
                                continue;
                            }
                        }

                        if (!contractIds.includes(contract.contract_id)) {
                            contracts.push(contract);
                            contractIds.push(contract.contract_id);
                        }
                    }
                }
            }
        }

        return contracts;
    }

    static get(id) {
        return characters[id];
    }

    static load() {
        if (characters === undefined) {
            let rawCharacters = charactersStore.get('characters');
            let newCharacters = {};

            if (rawCharacters !== undefined) {
                Object.keys(rawCharacters).map(id => {
                    newCharacters[id.toString()] = new Character();
                    Object.assign(newCharacters[id.toString()], rawCharacters[id]);
                    newCharacters[id.toString()].id = id.toString();
                });
            }

            characters = newCharacters;
        }
    }

    save() {
        if (characters !== undefined) {
            characters[this.id] = this;

            if (charactersSaveTimeout !== undefined) {
                clearTimeout(charactersSaveTimeout);
            }

            charactersSaveTimeout = setTimeout(() => {
                charactersStore.set('characters', characters);
            }, 10000);
        }
    }

    saveImmediately() {
        if (characters !== undefined) {
            characters[this.id] = this;

            if (charactersSaveTimeout !== undefined) {
                clearTimeout(charactersSaveTimeout);
            }

            charactersStore.set('characters', characters);
        }
    }

    static subscribe(component) {
        return subscribedComponents.push(component) - 1;
    }

    static unsubscribe(id) {
        subscribedComponents[id] = null;
    }

    static suspendSubscribers() {
        for (let component of subscribedComponents) {
            if (component !== null) {}
        }
    }

    static pushToSubscribers() {
        for (let component of subscribedComponents) {
            if (component !== null) {
                component.setState({ 'characters': Object.values(Character.getAll()).sort((a, b) => b.getTotalSp() - a.getTotalSp()) });
            }
        }
    }
}

Character.load();

setInterval(Character.build, 15000);

export default Character;