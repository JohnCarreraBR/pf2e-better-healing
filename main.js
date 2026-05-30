/**
 * PF2e Treat Wounds Accumulator
 * Main Module Script
 */

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

class TreatWoundsAccumulator extends HandlebarsApplicationMixin(ApplicationV2) {
  
  static DEFAULT_OPTIONS = {
    id: "pf2e-treat-wounds-accumulator",
    classes: ["pf2e", "sheet", "treat-wounds-tracker"],
    window: {
      title: "Treat Wounds Tracker",
      minimizable: true,
      resizable: true,
      controls: []
    },
    position: { 
      width: 720, 
      height: 620 
    }
  };

  static PARTS = {
    form: { 
      template: "modules/pf2e-better-healing/templates/accumulator-window.hbs" 
    }
  };

  constructor(options = {}) {
    super(options);
    this.accumulatorData = {};
    this.cooldowns = {}; 
    this.minutesPassed = 0;
    this.lastTargetActorId = null;
    this.treatedThisPeriod = []; 
  }

  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    
    const hours = Math.floor(this.minutesPassed / 60);
    const mins = this.minutesPassed % 60;
    context.timeDisplayString = `${hours}h ${mins}m`;

    const controlledTokens = canvas.tokens.controlled;
    const healerActor = controlledTokens[0]?.actor;
    
    let maxPatients = 1;
    let healerName = "No Healer Selected";
    let hasWardMedic = false;

    if (healerActor) {
      healerName = healerActor.name;
      hasWardMedic = healerActor.itemTypes?.feat?.some(f => f.slug === "ward-medic" || f.name.toLowerCase().includes("ward medic"));
      
      if (hasWardMedic) {
        // Robust fetch utilizing official PF2e system operational wrappers
        const medRank = healerActor.skills?.medicine?.rank ?? healerActor.system.skills?.med?.rank ?? 0;
        if (medRank >= 4) maxPatients = 8;       // Legendary
        else if (medRank === 3) maxPatients = 4;  // Master
        else maxPatients = 2;                     // Trained / Expert
      }
    }

    context.healerInfo = {
      name: healerName,
      currentCount: this.treatedThisPeriod.length,
      maxPatients: maxPatients,
      isAtCap: this.treatedThisPeriod.length >= maxPatients,
      hasWardMedic: hasWardMedic
    };

    const targets = game.actors.party?.members.map(m => m.getActiveTokens()[0] || m) || [];

    context.actors = targets.map(target => {
      const isToken = target instanceof Token || target.documentName === "Token";
      const actor = isToken ? target.actor : target;
      if (!actor) return null;

      const hp = actor.system.attributes.hp;
      const missingHp = hp.max - hp.value;
      
      if (this.accumulatorData[actor.id] === undefined) {
        this.accumulatorData[actor.id] = 0;
      }

      const expirationTime = this.cooldowns[actor.id] || 0;
      const remainingCooldown = Math.max(0, expirationTime - this.minutesPassed);
      const isImmune = remainingCooldown > 0;

      const accumulated = this.accumulatorData[actor.id];
      const imgPath = isToken ? (target.document?.texture?.src || target.texture?.src) : actor.img;

      return {
        id: actor.id,
        name: actor.name,
        img: imgPath || actor.img,
        hpValue: hp.value,
        hpMax: hp.max,
        missingHp: missingHp,
        isFull: missingHp <= 0,
        hpPercent: Math.clamp((hp.value / hp.max) * 100, 0, 100),
        accumulatedHealing: accumulated,
        accumulatedHealsToFull: missingHp > 0 && accumulated >= missingHp,
        isImmune: isImmune,
        cooldownRemaining: remainingCooldown,
        treatedThisPeriod: this.treatedThisPeriod.includes(actor.id)
      };
    }).filter(Boolean);

    return context;
  }

  _onRender(context, options) {
    super._onRender(context, options);
    
    const actionButtons = this.element.querySelectorAll("[data-action]");
    actionButtons.forEach(button => {
      button.addEventListener("click", (event) => {
        event.preventDefault();
        const actionName = button.dataset.action;
        
        if (this.constructor.ACTIONS[actionName]) {
          this.constructor.ACTIONS[actionName].call(this, event, button);
        }
      });
    });
  }

  /**
   * REAL GAME ACTIONS
   */
  static ACTIONS = {
    
    rollTreatWounds: async function(event, target) {
      const targetActorId = target.dataset.actorId;
      const targetActor = game.actors.get(targetActorId);
      if (!targetActor) return;

      const expirationTime = this.cooldowns[targetActorId] || 0;
      if (expirationTime > this.minutesPassed) {
         ui.notifications.warn(`${targetActor.name} is immune to Treat Wounds for another ${expirationTime - this.minutesPassed} minutes.`);
         return;
      }

      const controlledTokens = canvas.tokens.controlled;
      if (controlledTokens.length === 0) {
        ui.notifications.warn("Please select a Token to perform the Treat Wounds action!");
        return;
      }
      const healerActor = controlledTokens[0].actor;

      let maxPatients = 1;
      const hasWardMedic = healerActor.itemTypes?.feat?.some(f => f.slug === "ward-medic" || f.name.toLowerCase().includes("ward medic"));
      if (hasWardMedic) {
        const medRank = healerActor.skills?.medicine?.rank ?? healerActor.system.skills?.med?.rank ?? 0;
        if (medRank >= 4) maxPatients = 8;
        else if (medRank === 3) maxPatients = 4;
        else maxPatients = 2;
      }

      if (this.treatedThisPeriod.length >= maxPatients && !this.treatedThisPeriod.includes(targetActorId)) {
        ui.notifications.warn(`${healerActor.name} has already reached their Ward Medic capacity limit of ${maxPatients} patients for this period.`);
        return;
      }

      if (game.pf2e.actions.treatWounds) {
         this.lastTargetActorId = targetActorId;

         if (!this.treatedThisPeriod.includes(targetActorId)) {
            this.treatedThisPeriod.push(targetActorId);
         }

         const hasContinualRecovery = healerActor?.itemTypes?.feat?.some(f => f.slug === "continual-recovery" || f.name.toLowerCase().includes("continual recovery"));
         
         if (hasContinualRecovery) {
           this.cooldowns[targetActorId] = this.minutesPassed + 10;
         } else {
           this.cooldowns[targetActorId] = this.minutesPassed + 60;
         }

         // AUTOMATIC TIME ADVANCEMENT CAP CHECK
         let autoAdvancedTime = false;
         if (this.treatedThisPeriod.length === maxPatients) {
            this.minutesPassed += 10;
            this.treatedThisPeriod = []; 
            autoAdvancedTime = true;
         } else if (!hasWardMedic) {
            // Standard healer loop: Fall back to automatically advancing time per individual treatment
            this.minutesPassed += 10;
            this.treatedThisPeriod = [];
         }

         const targetTokenInstance = targetActor.getActiveTokens()[0];
         if (targetTokenInstance) {
           targetTokenInstance.setTarget(true, { releaseOthers: true, groupSelection: false });
         }

         game.pf2e.actions.treatWounds({ 
           actors: [healerActor],
           event: event
         });
         
         if (autoAdvancedTime) {
            ui.notifications.info("Ward Medic capacity limit reached. Session time automatically advanced by 10 minutes!");
         }
         
         this.render();
      } else {
        ui.notifications.warn("PF2e Treat Wounds system action not found.");
      }
    },

    applyHealing: async function(event, target) {
      const actorId = target.dataset.actorId;
      const actor = game.actors.get(actorId);
      const amount = this.accumulatorData[actorId] || 0;

      if (actor) {
        const currentHp = actor.system.attributes.hp.value;
        const maxHp = actor.system.attributes.hp.max;
        
        if (amount > 0) {
          await actor.update({ "system.attributes.hp.value": Math.min(maxHp, currentHp + amount) });
          ui.notifications.info(`Applied +${amount} HP healing to ${actor.name}.`);
        } else if (amount < 0) {
          const damageAmount = Math.abs(amount);
          await actor.update({ "system.attributes.hp.value": Math.max(0, currentHp - damageAmount) });
          ui.notifications.warn(`Dealt ${damageAmount} damage to ${actor.name} from negative pool.`);
        } else {
          ui.notifications.warn(`No changes pending for ${actor.name}.`);
          return;
        }
        
        this.accumulatorData[actorId] = 0;
        this.render(); 
      }
    },

    applyAllHealing: async function(event, button) {
      const keys = Object.keys(this.accumulatorData);
      let changesMade = false;

      for (const actorId of keys) {
        const amount = this.accumulatorData[actorId] || 0;
        if (amount === 0) continue;

        const actor = game.actors.get(actorId);
        if (!actor) continue;

        const currentHp = actor.system.attributes.hp.value;
        const maxHp = actor.system.attributes.hp.max;

        if (amount > 0) {
          await actor.update({ "system.attributes.hp.value": Math.min(maxHp, currentHp + amount) });
        } else if (amount < 0) {
          await actor.update({ "system.attributes.hp.value": Math.max(0, currentHp - Math.abs(amount)) });
        }
        
        this.accumulatorData[actorId] = 0;
        changesMade = true;
      }

      if (changesMade) {
        ui.notifications.info("Successfully synchronized and applied all changes to the party status sheets!");
        this.render();
      } else {
        ui.notifications.warn("No adjustments were pending inside any current pool tracking matrices.");
      }
    },

    stepTimerTenMins: function(event, button) {
      this.minutesPassed += 10;
      this.treatedThisPeriod = []; 
      ui.notifications.info("Advanced session clock by 10 minutes. A new treatment period has begun.");
      this.render();
    },

    resetTimer: function(event, button) {
      this.minutesPassed = 0;
      this.cooldowns = {}; 
      this.treatedThisPeriod = [];
      ui.notifications.info("Treatment tracking metrics, immunities, and batch counts reset to zero.");
      this.render();
    }
  };
}

/**
 * INITIALIZATION HOOK
 */
Hooks.once("init", () => {
  globalThis.TreatWoundsAccumulator = TreatWoundsAccumulator;
  
  console.log(
    "%c PF2e Better Healing | Module loaded successfully! 💉", 
    "background: #111; color: #00ff00; font-size: 13px; font-weight: bold; padding: 4px;"
  );
});

Hooks.on("updateActor", (actor, changes, options, userId) => {
  const openWindow = foundry.applications.instances.get("pf2e-treat-wounds-accumulator");
  if (openWindow && openWindow.rendered) {
    openWindow.render();
  }
});

/**
 * CHAT INTERCEPTOR
 */
Hooks.on("createChatMessage", (message, options, userId) => {
  const textContent = (message.content || "") + (message.flavor || "");
  const lowerText = textContent.toLowerCase();

  const isTreatWounds = message.flags?.pf2e?.context?.action === "treat-wounds" || 
                        lowerText.includes("treat wounds");

  if (isTreatWounds) {
    const openWindow = foundry.applications.instances.get("pf2e-treat-wounds-accumulator");
    if (!openWindow) return;

    let actualMatchedId = null;

    if (openWindow.lastTargetActorId) {
        actualMatchedId = openWindow.lastTargetActorId;
    } else if (message.flags?.pf2e?.context?.target?.actor) {
        actualMatchedId = message.flags.pf2e.context.target.actor;
    } else {
        for (const key of Object.keys(openWindow.accumulatorData)) {
            const checkActor = game.actors.get(key);
            if (checkActor && textContent.includes(checkActor.name)) {
                actualMatchedId = key;
                break;
            }
        }
    }

    if (!actualMatchedId) return;
    const targetActor = game.actors.get(actualMatchedId);

    let rollValue = message.rolls?.[0]?.total || 0;
    
    if (message.flags?.pf2e?.context?.type === "skill-check" && !lowerText.includes("healing")) {
       return; 
    }

    if (rollValue === 0 || lowerText.includes("regains") || lowerText.includes("takes")) {
       const regMatch = textContent.match(/\b\d+\b/);
       if (regMatch) rollValue = parseInt(regMatch[0], 10);
    }
    if (rollValue <= 0) return;

    openWindow.lastTargetActorId = null;

    const isCritFail = message.flags?.pf2e?.context?.outcome === "criticalFailure" || 
                       message.flags?.pf2e?.context?.outcome === 0 ||
                       lowerText.includes("critical failure") ||
                       lowerText.includes("takes"); 

    if (isCritFail) {
        openWindow.accumulatorData[actualMatchedId] = (openWindow.accumulatorData[actualMatchedId] || 0) - rollValue;
        ui.notifications.error(`Critical Failure! Subtracted ${rollValue} from ${targetActor ? targetActor.name : "target"}.`);
    } else {
        let appliedBonuses = [];

        if (targetActor) {
            const hasRobustHealth = targetActor.itemTypes?.feat?.some(f => f.slug === "robust-health" || f.name.toLowerCase().includes("robust health"));
            if (hasRobustHealth) {
                const targetLevel = targetActor.level || 1;
                rollValue += targetLevel;
                appliedBonuses.push(`Robust Health +${targetLevel}`);
            }

            const hasGodlessHealing = targetActor.itemTypes?.feat?.some(f => f.slug === "godless-healing" || f.name.toLowerCase().includes("godless healing"));
            if (hasGodlessHealing) {
                rollValue += 5;
                appliedBonuses.push(`Godless Healing +5`);
            }
        }

        const bonusString = appliedBonuses.length > 0 ? ` (${appliedBonuses.join(", ")})` : "";

        openWindow.accumulatorData[actualMatchedId] = (openWindow.accumulatorData[actualMatchedId] || 0) + rollValue;
        ui.notifications.info(`Added +${rollValue} to ${targetActor ? targetActor.name : "target"}!${bonusString}`);
    }
    
    openWindow.render();
  }
});
