const axios = require('axios');
const KeyManager = require('./KeyManager.js');

/**
 * GPT Wrapper Class - Universal AI Chat Interface
 * Supports threading, multiple models, and configurable parameters
 * Can be reused across multiple projects
 */
class GPTWrapper {
  constructor(config = {}) {
    // Load OpenAI key from .Keys/OpenAI.key if not provided in config
    const apiKey = config.apiKey || KeyManager.LoadOpenAIKey();

    this.config = {
      apiKey,
      baseURL: config.baseURL || 'https://api.openai.com/v1',
      model: config.model || 'gpt-3.5-turbo',
      timeout: config.timeout || 30000,
      maxRetries: config.maxRetries || 3,
      retryDelay: config.retryDelay || 1000,
    };

    this.client = null;
    this.isInitialized = false;
    this.threads = new Map(); // Store conversation threads
    this.conversationHistory = new Map(); // Store message history per thread
    this.chainOfThought = []; // Store decision chain (last 5 in memory)
    this.dbCallback = null; // Function to persist decisions to database
    this.decisionDB = null; // DecisionDB instance for auto-loop persistence
  }

  /**
   * Set DecisionDB instance for persisting AutoProcess loops
   * @param {DecisionDB} decisionDBInstance - Instance of DecisionDB
   */
  SetDecisionDB(decisionDBInstance) {
    this.decisionDB = decisionDBInstance;
    return this;
  }

  /**
   * Initialize the GPT connection
   * @param {boolean} Initial - Whether this is the first initialization
   * @returns {Promise<boolean>}
   */
  async Initialize(Initial = true) {
    try {
      // Validate configuration
      if (!this.config.apiKey) {
        throw new Error('API Key not found. Add OpenAI API key to .Keys/OpenAI.key');
      }

      // Create axios instance
      this.client = axios.create({
        baseURL: this.config.baseURL,
        headers: {
          'Authorization': `Bearer ${this.config.apiKey}`,
          'Content-Type': 'application/json',
        },
        timeout: this.config.timeout,
      });

      // Test connection if Initial
      if (Initial) {
        await this._TestConnection();
      }

      this.isInitialized = true;
      console.log('GPT Wrapper initialized successfully');
      return true;
    } catch (error) {
      console.error('Failed to initialize GPT Wrapper:', error.message);
      return false;
    }
  }

  /**
   * Test the connection to OpenAI API
   * @returns {Promise<boolean>}
   * @private
   */
  async _TestConnection() {
    try {
      const response = await this.client.get('/models');
      return response.status === 200;
    } catch (error) {
      throw new Error(`Connection test failed: ${error.message}`);
    }
  }

  /**
   * Establish or retrieve a connection
   * @param {boolean} Initial - Whether to create a new connection
   * @returns {Promise<Object>}
   */
  async Connection(Initial = false) {
    if (!this.isInitialized && !Initial) {
      throw new Error('GPT Wrapper not initialized. Call Initialize() first.');
    }

    if (Initial) {
      const initialized = await this.Initialize(Initial);
      if (!initialized) {
        throw new Error('Failed to initialize connection');
      }
    }

    return {
      isActive: this.isInitialized,
      client: this.client,
      config: this.config,
      threadCount: this.threads.size,
    };
  }

  /**
   * Send a chat message with optional threading support
   * @param {string} message - The message to send
   * @param {boolean|Object} Threading - Threading config or boolean
   * @returns {Promise<Object>}
   */
  async Chat(message, Threading = true) {
    try {
      if (!this.isInitialized) {
        throw new Error('GPT Wrapper not initialized');
      }

      if (!message || typeof message !== 'string') {
        throw new Error('Message must be a non-empty string');
      }

      // Parse threading options
      const threadConfig = this._parseThreadingConfig(Threading);
      const threadId = threadConfig.threadId || this._generateThreadId();

      // Initialize thread if not exists
      if (!this.threads.has(threadId)) {
        this.threads.set(threadId, {
          created: new Date(),
          messageCount: 0,
        });
        this.conversationHistory.set(threadId, []);
      }

      // Check if new messages are allowed
      if (threadConfig.useThread && !threadConfig.allowNew && !this.conversationHistory.has(threadId)) {
        throw new Error(`Thread ${threadId} does not exist and Allow_New is false`);
      }

      // Build message history
      const history = this.conversationHistory.get(threadId) || [];
      history.push({
        role: 'user',
        content: message,
      });

      // Send request to OpenAI
      const response = await this._sendRequest(history);

      // Store response in history
      const assistantMessage = response.choices[0].message.content;
      history.push({
        role: 'assistant',
        content: assistantMessage,
      });

      this.conversationHistory.set(threadId, history);
      this.threads.get(threadId).messageCount++;

      return {
        success: true,
        threadId,
        message: assistantMessage,
        tokensUsed: response.usage,
        threadMetadata: this.threads.get(threadId),
      };
    } catch (error) {
      return {
        success: false,
        error: error.message,
        threadId: Threading && typeof Threading === 'object' ? Threading.threadId : undefined,
      };
    }
  }

  /**
   * Parse threading configuration
   * @param {boolean|Object} Threading
   * @returns {Object}
   * @private
   */
  _parseThreadingConfig(Threading) {
    const defaultConfig = {
      useThread: true,
      allowNew: true,
      threadId: null,
    };

    switch (typeof Threading) {
      case 'boolean':
        return { ...defaultConfig, useThread: Threading };
      case 'object':
        return Threading ? { ...defaultConfig, ...Threading } : defaultConfig;
      default:
        return defaultConfig;
    }
  }

  /**
   * Send request with retry logic
   * @param {Array} messages
   * @returns {Promise<Object>}
   * @private
   */
  async _sendRequest(messages, attempt = 1) {
    try {
      const response = await this.client.post('/chat/completions', {
        model: this.config.model,
        messages,
        temperature: 0.7,
        max_tokens: 2000,
      });

      return response.data;
    } catch (error) {
      if (attempt < this.config.maxRetries && this._isRetryable(error)) {
        await new Promise((resolve) =>
          setTimeout(resolve, this.config.retryDelay * attempt)
        );
        return this._sendRequest(messages, attempt + 1);
      }
      throw error;
    }
  }

  /**
   * Check if error is retryable
   * @param {Error} error
   * @returns {boolean}
   * @private
   */
  _isRetryable(error) {
    const retryableStatuses = [408, 429, 500, 502, 503, 504];
    return retryableStatuses.includes(error.response?.status) || 
           error.code === 'ECONNABORTED';
  }

  /**
   * Decision Tree Processor - Think, Validate, Act, Think
   * Uses GPT as a decision service with structured chain of thought
   * @param {string} query - The prompt/query to process
   * @param {Function} dbCallback - Optional callback for database persistence
   * @returns {Promise<Object>}
   */
  async Process(query, dbCallback = null) {
    try {
      if (!this.isInitialized) {
        throw new Error('GPT Wrapper not initialized');
      }

      if (!query || typeof query !== 'string') {
        throw new Error('Query must be a non-empty string');
      }

      // Store database callback
      if (dbCallback && typeof dbCallback === 'function') {
        this.dbCallback = dbCallback;
      }

      // Generate decision ID
      const decisionId = this._generateDecisionId();
      const timestamp = new Date();

      // Step 1: THINK (initial analysis)
      console.log(`\n[THINK] Analyzing request...`);
      const thinkResponse = await this._ProcessStep(
        'think',
        query,
        'You are analyzing the request. What action should we take? What is your confidence?'
      );

      // Step 2: VALIDATE (check feasibility based on THINK result)
      console.log(`[VALIDATE] Checking feasibility...`);
      const validateResponse = await this._ProcessStep(
        'validate',
        `Market context:\n${query}\n\nProposed action from analysis: ${JSON.stringify(thinkResponse)}`,
        'Validate if the proposed action is feasible. Is it executable? What are the risks?'
      );

      // Step 3: ACT (execute decision using THINK + VALIDATE context)
      // Pass both THINK and VALIDATE results so ACT knows what was analyzed
      console.log(`[ACT] Determining actions...`);
      const actResponse = await this._ProcessStep(
        'act',
        `Market context:\n${query}\n\nAnalysis result: ${JSON.stringify(thinkResponse)}\nValidation result: ${JSON.stringify(validateResponse)}`,
        'Based on the analysis and validation above, if feasible=true then execute the proposed action. Return as JSON array.'
      );

      // Step 4: REFLECT (plan next steps)
      console.log(`[REFLECT] Planning next steps...`);
      const reflectResponse = await this._ProcessStep(
        'reflect',
        `Executed action: ${JSON.stringify(actResponse.actions)}`,
        'Reflect on the execution. What should happen next? How long should we monitor?'
      );

      // Build decision object with signal-based responses
      const decision = {
        id: decisionId,
        timestamp,
        query,
        marketAnalysis: null, // Will be populated if available
        chain: [
          {
            step: 'think',
            signal: thinkResponse.signal,
            action_type: thinkResponse.action_type,
            confidence: thinkResponse.confidence,
            metadata: thinkResponse.metadata,
          },
          {
            step: 'validate',
            feasible: validateResponse.feasible,
            risk_level: validateResponse.risk_level,
            blocking_issues: validateResponse.blocking_issues || [],
            metadata: validateResponse.metadata,
          },
          {
            step: 'act',
            actions: Array.isArray(actResponse.actions) ? actResponse.actions : [],
            status: 'planned',
          },
          {
            step: 'reflect',
            next_action: reflectResponse.next_action,
            timeframe: reflectResponse.timeframe,
            watch_metrics: reflectResponse.watch_metrics || [],
            metadata: reflectResponse.metadata,
          },
        ],
      };

      // Add market analysis if available
      if (typeof global !== 'undefined' && global.process && global.process.marketAnalysis) {
        try {
          // Extract market data from context if available, or fetch fresh data
          decision.marketAnalysis = global.process.marketAnalysis.analysisCache && 
            global.process.marketAnalysis.analysisCache.size > 0 ?
            Array.from(global.process.marketAnalysis.analysisCache.values())[0]?.data :
            null;
        } catch (e) {
          // Silently fail if market analysis not available
        }
      }

      // Store in memory (keep last 5)
      this.chainOfThought.push(decision);
      if (this.chainOfThought.length > 5) {
        this.chainOfThought.shift();
      }

      // Persist to database if callback provided
      if (this.dbCallback) {
        try {
          await this.dbCallback(decision);
          console.log(`Decision persisted to database`);
        } catch (dbError) {
          console.warn(`Failed to persist decision:`, dbError.message);
        }
      }

      console.log(`[PROCESS] Complete - Decision ID: ${decisionId}`);

      return {
        success: true,
        decisionId,
        decision,
      };
    } catch (error) {
      console.error(`[PROCESS] Failed:`, error.message);
      return {
        success: false,
        error: error.message,
      };
    }
  }

  /**
   * Automated Decision Loop - Self-querying decision engine
   * GPT makes decisions repeatedly until terminal action reached
   * Provide only initial prompt; GPT handles everything else
   * @param {string} initialPrompt - Starting query
   * @param {Object} config - Loop configuration
   * @param {number} config.maxIterations - Max steps (default: 10)
   * @param {number} config.timeoutMs - Max runtime in ms (default: 300000 = 5 min)
   * @param {Function} config.dbCallback - Optional database callback
   * @param {Array} config.terminalActions - Actions that end loop (default: ['complete', 'wait', 'error'])
   * @returns {Promise<Object>}
   */
  async AutoProcess(initialPrompt, config = {}) {
    try {
      if (!this.isInitialized) {
        throw new Error('GPT Wrapper not initialized');
      }

      // Merge with defaults
      const loopConfig = {
        maxIterations: config.maxIterations || 10,
        timeoutMs: config.timeoutMs || 300000, // 5 minutes
        dbCallback: config.dbCallback || this.dbCallback,
        terminalActions: config.terminalActions || ['complete', 'wait', 'error', 'stop'],
      };

      // Generate loop ID
      const loopId = this._generateLoopId();
      const startTime = new Date();
      let currentPrompt = initialPrompt;
      let iteration = 0;
      let lastDecision = null;
      const loopDecisions = [];

      console.log(`\n[AUTOPROCESS] Starting loop: ${loopId}`);
      console.log(`   Initial Prompt: "${initialPrompt.substring(0, 100)}..."`);
      console.log(`   Config: max ${loopConfig.maxIterations} iterations, ${loopConfig.timeoutMs / 1000}s timeout\n`);

      // Main loop
      while (iteration < loopConfig.maxIterations) {
        // Check timeout
        const elapsed = Date.now() - startTime.getTime();
        if (elapsed > loopConfig.timeoutMs) {
          console.warn(`[AUTOPROCESS] Timeout reached after ${elapsed / 1000}s`);
          break;
        }

        iteration++;
        console.log(`🔁 [AUTOPROCESS] Iteration ${iteration}/${loopConfig.maxIterations}`);

        // Make decision
        const decision = await this.Process(currentPrompt, loopConfig.dbCallback);

        if (!decision.success) {
          console.error(`[AUTOPROCESS] Decision process failed: ${decision.error}`);
          break;
        }

        lastDecision = decision.decision;
        loopDecisions.push(lastDecision);

        // Link decisions in database
        if (loopConfig.dbCallback && lastDecision) {
          lastDecision.loop_id = loopId;
          await loopConfig.dbCallback(lastDecision);
        }

        // Extract actions from the 'act' step
        const actStep = lastDecision.chain.find((c) => c.step === 'act');
        const actions = actStep?.actions || [];

        console.log(`   Actions: ${actions.map((a) => a.action).join(', ')}`);

        // Check for terminal actions
        const hasTerminalAction = actions.some((action) =>
          loopConfig.terminalActions.includes(action.action)
        );

        if (hasTerminalAction) {
          const terminalAction = actions.find((a) =>
            loopConfig.terminalActions.includes(a.action)
          );
          console.log(`🛑 [AUTOPROCESS] Terminal action reached: ${terminalAction.action}`);
          break;
        }

        // Extract next step from reflect phase
        const reflectStep = lastDecision.chain.find((c) => c.step === 'reflect');
        const nextSteps = reflectStep?.nextSteps || '';

        // Prepare prompt for next iteration
        currentPrompt = `Previous decision: ${JSON.stringify(
          actions.map((a) => ({ action: a.action, params: a }))
        )}\n\nNext steps: ${nextSteps}\n\nWhat should we do now?`;

        console.log(`   → Next iteration prompt prepared\n`);

        // Small delay between iterations
        await new Promise((resolve) => setTimeout(resolve, 500));
      }

      // Build loop summary
      const endTime = new Date();
      const duration = endTime - startTime;
      const loopSummary = {
        loopId,
        status: iteration >= loopConfig.maxIterations ? 'timeout' : 'completed',
        iterations: iteration,
        totalTime: duration,
        decisionsCount: loopDecisions.length,
        finalAction:
          loopDecisions.length > 0
            ? loopDecisions[loopDecisions.length - 1].chain.find((c) => c.step === 'act')?.actions[0]?.action
            : null,
        decisions: loopDecisions,
      };

      console.log(`\n[AUTOPROCESS] Loop completed`);
      console.log(`   Total iterations: ${loopSummary.iterations}`);
      console.log(`   Total time: ${(duration / 1000).toFixed(2)}s`);
      console.log(`   Final action: ${loopSummary.finalAction || 'none'}\n`);

      // Save loop metadata to database if available
      if (this.decisionDB) {
        const loopData = {
          initialPrompt,
          status: loopSummary.status,
          decisionCount: loopSummary.decisionsCount,
          endTime: new Date().toISOString(),
          finalOutcome: `Final action: ${loopSummary.finalAction || 'none'}, Completed in ${iteration} iterations`,
          config: loopConfig,
        };
        await this.decisionDB.SaveAutoLoop(loopId, loopData);
        console.log(`[AUTOPROCESS] Loop metadata saved to database`);
      }

      return {
        success: true,
        ...loopSummary,
      };
    } catch (error) {
      console.error(`[AUTOPROCESS] Failed:`, error.message);
      return {
        success: false,
        error: error.message,
      };
    }
  }

  /**
   * Generate unique loop ID
   * @returns {string}
   * @private
   */
  _generateLoopId() {
    return `loop_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * Process a single step in the decision tree
   * @param {string} stepName
   * @param {string} context
   * @param {string} instruction
   * @returns {Promise<Object>}
   * @private
   */
  async _ProcessStep(stepName, context, instruction) {
    try {
      let systemPrompt = `You are a trading decision API. Respond ONLY with valid JSON. No explanation. No text. Just JSON.`;
      let userMessage = ``;
      const gptLogging = typeof process !== 'undefined' && process.GPT_LOGGING;

      if (stepName === 'act') {
        systemPrompt = `You are a pure JSON API. Your ONLY job is to return a valid JSON array. No explanation. No text. Just array.
CRITICAL: You must respond with a 100% valid JSON array. This will be parsed by a JSON parser.
Start your response with [ and end with ]. Nothing before [ and nothing after ].`;
        
        userMessage = `Market State:
${context}

Choose ONE action and respond with ONLY this JSON array format. No other text.

EXAMPLES OF VALID RESPONSES:
[{"action":"sell","quantity":0.3,"price":55.71}]
[{"action":"buy","quantity":0.5,"price":55.71}]
[{"action":"wait","seconds":5}]
[{"action":"complete"}]
[{"action":"query"}]

Pick the best action from viable actions listed above. Return a JSON array with ONE object. Start with [ end with ]. No other text.`;
      } else if (stepName === 'think') {
        systemPrompt = `You are a pure JSON signal API. Respond with ONLY valid JSON object. No explanation. No text. No markdown.
Start with { and end with }. Nothing before { and nothing after }.`;
        
        userMessage = `${instruction}

Context:
${context}

Respond with ONLY this JSON format. No other text:
{
  "signal": "ready_to_act",
  "action_type": "buy|sell|wait|query|complete",
  "confidence": 0.9,
  "metadata": {"complete": true}
}`;
      } else if (stepName === 'validate') {
        systemPrompt = `You are a pure JSON signal API. Respond with ONLY valid JSON object. No explanation. No text. No markdown.
Start with { and end with }. Nothing before { and nothing after }.`;
        
        userMessage = `${instruction}

Context:
${context}

Respond with ONLY this JSON format. No other text:
{
  "feasible": true,
  "risk_level": "low|medium|high",
  "blocking_issues": [],
  "metadata": {"complete": true}
}`;
      } else if (stepName === 'reflect') {
        systemPrompt = `You are a pure JSON signal API. Respond with ONLY valid JSON object. No explanation. No text. No markdown.
Start with { and end with }. Nothing before { and nothing after }.`;
        
        userMessage = `${instruction}

Context:
${context}

Respond with ONLY this JSON format. No other text:
{
  "next_action": "continue|stop|monitor",
  "timeframe": 5,
  "watch_metrics": [],
  "metadata": {"complete": true}
}`;
      }

      const messages = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage },
      ];

      const response = await this._sendRequest(messages);
      const content = response.choices[0].message.content.trim();

      // DEBUG: Logging disabled - system is working correctly
      // if (gptLogging) { ... }

      // Map step names to expected output keys
      const stepKeyMap = {
        'think': 'reasoning',
        'validate': 'validation',
        'act': 'actions',
        'reflect': 'nextSteps',
      };

      const outputKey = stepKeyMap[stepName] || stepName;

      // Try to parse JSON from response
      let parsed = { [outputKey]: content, metadata: { stepName } };
      
      if (stepName === 'act') {
        // ACT step: Must parse JSON array
        try {
          // Remove markdown code blocks if present
          let cleanContent = content;
          if (cleanContent.includes('```')) {
            cleanContent = cleanContent.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
          }

          // Try to find and parse JSON array
          let jsonArray = null;
          
          // First: Try to parse as-is
          if (cleanContent.startsWith('[')) {
            try {
              jsonArray = JSON.parse(cleanContent);
            } catch (e) {
              // Try to extract array
              const arrayMatch = cleanContent.match(/\[\s*\{[\s\S]*?\}\s*\]/);
              if (arrayMatch) {
                jsonArray = JSON.parse(arrayMatch[0]);
              }
            }
          }
          
          // Second: Try to extract from text if not array
          if (!jsonArray) {
            const arrayMatch = cleanContent.match(/\[\s*\{[\s\S]*?\}\s*\]/);
            if (arrayMatch) {
              jsonArray = JSON.parse(arrayMatch[0]);
            }
          }
          
          // Ensure it's an array
          if (jsonArray && !Array.isArray(jsonArray)) {
            jsonArray = [jsonArray];
          }

          if (jsonArray && Array.isArray(jsonArray) && jsonArray.length > 0) {
            parsed = { [outputKey]: jsonArray, metadata: { stepName, parsed: true, source: 'json' } };
            if (gptLogging) console.log(`[DEBUG_ACT_PARSED] ${jsonArray.length} actions found`);
          } else {
            parsed = { [outputKey]: [], metadata: { stepName, parsed: false, rawContent: cleanContent } };
            if (gptLogging) console.log(`[DEBUG_ACT_NOJSON] No valid JSON array found`);
          }
        } catch (parseError) {
          parsed = { [outputKey]: [], metadata: { stepName, error: parseError.message, rawContent: content } };
          if (gptLogging) console.log(`[DEBUG_ACT_ERROR] ${parseError.message}`);
        }
      } else {
        // Other steps (Think, Validate, Reflect): Must parse as JSON object
        try {
          let cleanContent = content;
          if (cleanContent.includes('```')) {
            cleanContent = cleanContent.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
          }

          let jsonObj = null;
          
          // First: Try to parse as-is if it looks like JSON
          if (cleanContent.startsWith('{')) {
            try {
              jsonObj = JSON.parse(cleanContent);
            } catch (e) {
              // Try to extract object
              const objMatch = cleanContent.match(/\{\s*[\s\S]*?\}/);
              if (objMatch) {
                jsonObj = JSON.parse(objMatch[0]);
              }
            }
          }
          
          // Second: Try to extract JSON object
          if (!jsonObj) {
            const objMatch = cleanContent.match(/\{\s*[\s\S]*?\}/);
            if (objMatch) {
              jsonObj = JSON.parse(objMatch[0]);
            }
          }

          if (jsonObj && typeof jsonObj === 'object') {
            parsed = { ...jsonObj, metadata: { stepName, parsed: true } };
            if (gptLogging) console.log(`[DEBUG_${stepName.toUpperCase()}_PARSED] JSON found`);
          } else {
            // If no valid JSON found, return an error structure
            parsed = { 
              [outputKey]: `Failed to parse JSON response for ${stepName}`,
              error: 'No valid JSON object found in response',
              metadata: { stepName, parsed: false, rawContent: content }
            };
            if (gptLogging) console.log(`[DEBUG_${stepName.toUpperCase()}_NOJSON] No JSON found - response was: ${content.substring(0, 100)}`);
          }
        } catch (parseError) {
          // Failed to parse, return error structure
          parsed = { 
            [outputKey]: `Error parsing ${stepName}: ${parseError.message}`,
            error: parseError.message,
            metadata: { stepName, parsed: false, rawContent: content }
          };
          if (gptLogging) console.log(`[DEBUG_${stepName.toUpperCase()}_ERROR] ${parseError.message}`);
        }
      }

      return parsed;
    } catch (error) {
      const stepKeyMap = {
        'think': 'reasoning',
        'validate': 'validation',
        'act': 'actions',
        'reflect': 'nextSteps',
      };
      const outputKey = stepKeyMap[stepName] || stepName;
      
      console.log(`[DEBUG_ERROR] ${stepName}: ${error.message}`);
      return {
        [outputKey]: stepName === 'act' ? [] : null,
        error: error.message,
        status: 500,
      };
    }
  }

  /**
   * Parse actions from API response
   * Extracts action objects with format: { action: "type", ...params }
   * @param {string} actionsText
   * @returns {Array}
   * @private
   */
  _parseActions(actionsText) {
    try {
      // Look for JSON objects in the response
      const actionMatches = actionsText.match(/\{[^}]*"action"[^}]*\}/g) || [];
      return actionMatches.map((match) => {
        try {
          return JSON.parse(match);
        } catch {
          return null;
        }
      }).filter(Boolean);
    } catch {
      return [];
    }
  }

  /**
   * Get chain of thought history
   * @returns {Array}
   */
  GetChainOfThought() {
    return this.chainOfThought;
  }

  /**
   * Query chain of thought by ID
   * @param {string} decisionId
   * @returns {Object|null}
   */
  GetDecision(decisionId) {
    return this.chainOfThought.find((d) => d.id === decisionId) || null;
  }

  /**
   * Clear chain of thought
   * @returns {boolean}
   */
  ClearChainOfThought() {
    this.chainOfThought = [];
    return true;
  }

  /**
   * Generate unique decision ID
   * @returns {string}
   * @private
   */
  _generateDecisionId() {
    return `decision_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * Get thread history
   * @param {string} threadId
   * @returns {Array}
   */
  GetThreadHistory(threadId) {
    return this.conversationHistory.get(threadId) || [];
  }

  /**
   * Clear a thread
   * @param {string} threadId
   * @returns {boolean}
   */
  ClearThread(threadId) {
    if (this.threads.has(threadId)) {
      this.threads.delete(threadId);
      this.conversationHistory.delete(threadId);
      return true;
    }
    return false;
  }

  /**
   * Get all active threads
   * @returns {Array}
   */
  GetAllThreads() {
    return Array.from(this.threads.entries()).map(([id, metadata]) => ({
      threadId: id,
      ...metadata,
    }));
  }

  /**
   * Close connection and cleanup
   * @returns {boolean}
   */
  Close() {
    this.threads.clear();
    this.conversationHistory.clear();
    this.client = null;
    this.isInitialized = false;
    console.log('GPT Wrapper connection closed');
    return true;
  }

  /**
   * Generate unique thread ID
   * @returns {string}
   * @private
   */
  _generateThreadId() {
    return `thread_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }
}

module.exports = GPTWrapper;
