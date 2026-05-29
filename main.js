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
      height: 580 
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
  }

  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    
    const hours = Math.floor(this.minutesPassed / 60);
    const mins = this.minutesPassed % 60;
    context.timeDisplayString = `${hours}h ${mins}m`;

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
        cooldownRemaining: remainingCooldown
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

      if (game.pf2e.actions.treatWounds) {
         this.lastTargetActorId = targetActorId;

         this.cooldowns[targetActorId] = this.minutesPassed + 60;
         this.minutesPassed += 10;

         const targetTokenInstance = targetActor.getActiveTokens()[0];
         if (targetTokenInstance) {
           targetTokenInstance.setTarget(true, { releaseOthers: true, groupSelection: false });
         }

         game.pf2e.actions.treatWounds({ 
           actors: [healerActor],
           event: event
         });
         
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
      this.render();
    },

    resetTimer: function(event, button) {
      this.minutesPassed = 0;
      this.cooldowns = {}; 
      ui.notifications.info("Treatment tracking metrics and immunities reset to zero.");
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
  const isTreatWounds = message.flags?.pf2e?.context?.action === "treat-wounds" || 
                        message.flavor?.toLowerCase().includes("treat wounds");

  if (isTreatWounds) {
    let rollValue = message.rolls?.[0]?.total || 0;
    if (rollValue <= 0) return;

    const openWindow = foundry.applications.instances.get("pf2e-treat-wounds-accumulator");
    if (openWindow) {
        let actualMatchedId = null;

        if (openWindow.lastTargetActorId && openWindow.accumulatorData[openWindow.lastTargetActorId] !== undefined) {
            actualMatchedId = openWindow.lastTargetActorId;
            openWindow.lastTargetActorId = null;
        } else if (message.flags?.pf2e?.context?.target?.actor && openWindow.accumulatorData[message.flags.pf2e.context.target.actor] !== undefined) {
            actualMatchedId = message.flags.pf2e.context.target.actor;
        } else {
            for (const key of Object.keys(openWindow.accumulatorData)) {
                const checkActor = game.actors.get(key);
                if (checkActor && message.flavor?.includes(checkActor.name)) {
                    actualMatchedId = key;
                    break;
                }
            }
        }

        if (!actualMatchedId && message.actor?.id && openWindow.accumulatorData[message.actor.id] !== undefined) {
            actualMatchedId = message.actor.id;
        }

        if (actualMatchedId) {
            const targetActor = game.actors.get(actualMatchedId);
            
            const isCritFail = message.flags?.pf2e?.context?.outcome === "criticalFailure" || 
                               message.flags?.pf2e?.context?.outcome === 0 ||
                               message.flavor?.toLowerCase().includes("critical failure");

            if (isCritFail) {
                openWindow.accumulatorData[actualMatchedId] = (openWindow.accumulatorData[actualMatchedId] || 0) - rollValue;
                ui.notifications.error(`Critical Failure! Subtracted ${rollValue} from ${targetActor ? targetActor.name : "target"}'s pool.`);
            } else {
                // ROBUST HEALTH FEAT CHECK
                let robustBonusText = "";
                if (targetActor) {
                    // Check if the target creature has the Robust Health feat item embedded on their sheet
                    const hasRobustHealth = targetActor.itemTypes?.feat?.some(f => f.slug === "robust-health" || f.name.toLowerCase().includes("robust health"));
                    
                    if (hasRobustHealth) {
                        const targetLevel = targetActor.level || 1;
                        rollValue += targetLevel;
                        robustBonusText = ` (Includes Robust Health bonus of +${targetLevel})`;
                    }
                }

                openWindow.accumulatorData[actualMatchedId] = (openWindow.accumulatorData[actualMatchedId] || 0) + rollValue;
                ui.notifications.info(`Added +${rollValue} to ${targetActor ? targetActor.name : "target"}'s pool!${robustBonusText}`);
            }
            
            openWindow.render();
        }
    }
  }
});
