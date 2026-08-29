import { StateGraph, Annotation, END, START } from '@langchain/langgraph';
import { ChatGoogleGenerativeAI } from '@langchain/google-genai';
import { BaseMessage, HumanMessage, AIMessage, SystemMessage, ToolMessage } from '@langchain/core/messages';
import type { RunnableConfig } from '@langchain/core/runnables';
import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { CAD_AI_SYSTEM_PROMPT } from './system-prompt';
import { extractOpenScadCode } from './code-extractor';
import { validateOpenScadCode } from './code-validator';
import { getFunctionalCadModuleTool } from './engineering-tools';

export interface StreamEventPayload {
  type: 'thinking' | 'generating' | 'validating' | 'fixing' | 'ready' | 'error' | 'token';
  message: string;
  code?: string;
  stl?: string;
  explanation?: string;
  timestamp: number;
}

export const AgentState = Annotation.Root({
  messages: Annotation<BaseMessage[]>({
    reducer: (x, y) => x.concat(y),
    default: () => [],
  }),
  assemblySpec: Annotation<any>({
    reducer: (_, y) => y,
    default: () => null,
  }),
  currentCode: Annotation<string>({
    reducer: (_, y) => y,
    default: () => '',
  }),
  explanation: Annotation<string>({
    reducer: (_, y) => y,
    default: () => '',
  }),
  validationError: Annotation<string | null>({
    reducer: (_, y) => y,
    default: () => null,
  }),
  attemptCount: Annotation<number>({
    reducer: (_, y) => y,
    default: () => 0,
  }),
  isValid: Annotation<boolean>({
    reducer: (_, y) => y,
    default: () => false,
  }),
  stlContent: Annotation<string | null>({
    reducer: (_, y) => y,
    default: () => null,
  }),
});

export type AgentStateType = typeof AgentState.State;

export function getGeminiModel(apiKey?: string, modelName?: string) {
  const key = apiKey || process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY;
  if (!key) {
    throw new Error('Google Gemini API Key is missing. Please set GOOGLE_API_KEY in your environment or .env.local.');
  }

  const selectedModel = modelName || process.env.GEMINI_MODEL || 'gemini-3.6-flash';

  return new ChatGoogleGenerativeAI({
    apiKey: key,
    model: selectedModel,
    temperature: 0.2,
    maxOutputTokens: 8192,
  });
}

const outputAssemblySpecTool = new DynamicStructuredTool({
  name: 'output_assembly_spec',
  description: 'Outputs the final validated Assembly IR (Intermediate Representation) JSON spec containing joint contracts and dimensional bounds.',
  schema: z.object({
    assemblyName: z.string(),
    boundingBox: z.object({ width: z.number(), length: z.number(), height: z.number() }),
    jointContracts: z.array(z.object({
      type: z.string(),
      clearance: z.number(),
      dimensions: z.object({
        length: z.number().optional(),
        width: z.number().optional(),
        height: z.number().optional(),
        depth: z.number().optional(),
        diameter: z.number().optional(),
        radius: z.number().optional(),
        thickness: z.number().optional(),
      }).optional()
    })).optional(),
    components: z.array(z.object({
      name: z.string(),
      description: z.string(),
      dimensions: z.object({
        length: z.number().optional(),
        width: z.number().optional(),
        height: z.number().optional(),
        depth: z.number().optional(),
        diameter: z.number().optional(),
        radius: z.number().optional(),
        thickness: z.number().optional(),
      }).optional()
    }))
  }),
  func: async (args) => {
    return JSON.stringify(args, null, 2);
  }
});

/**
 * Creates the CAD AI LangGraph agent graph with tool-calling capabilities.
 */
export function createCadAgent(
  apiKey?: string,
  onProgress?: (event: StreamEventPayload) => void,
  modelName?: string
) {
  const model = getGeminiModel(apiKey, modelName);
  
  // Architect uses output tool
  const architectModel = model.bindTools([outputAssemblySpecTool]);
  
  // Drafter uses engineering lookup tools
  const drafterModel = model.bindTools([getFunctionalCadModuleTool]);

  // Node 1: architectNode
  async function architectNode(state: AgentStateType, config?: RunnableConfig): Promise<Partial<AgentStateType>> {
    onProgress?.({
      type: 'thinking',
      message: 'Mechanical Architect: Analyzing design requirements and defining bounding boxes...',
      timestamp: Date.now(),
    });

    const messages: BaseMessage[] = [
      new SystemMessage(CAD_AI_SYSTEM_PROMPT),
      ...state.messages,
      new HumanMessage("As the Mechanical Architect, analyze the request, calculate dimensions, and use the 'output_assembly_spec' tool to provide the JSON IR. Do not write OpenSCAD code yet.")
    ];

    const response = await architectModel.invoke(messages, config);
    let spec = null;
    let explanation = typeof response.content === 'string' ? response.content : JSON.stringify(response.content);

    if (response.tool_calls && response.tool_calls.length > 0) {
      for (const toolCall of response.tool_calls) {
        if (toolCall.name === 'output_assembly_spec') {
          spec = toolCall.args;
          explanation += "\n\nAssembly Spec generated.";
        }
      }
    }

    return {
      assemblySpec: spec,
      explanation: explanation,
    };
  }

  // Node 2: drafterNode
  async function drafterNode(state: AgentStateType, config?: RunnableConfig): Promise<Partial<AgentStateType>> {
    onProgress?.({
      type: 'generating',
      message: 'Parametric Drafter: Generating Additive OpenSCAD geometry based on the Architect Spec...',
      timestamp: Date.now(),
    });

    const drafterPrompt = `As the Parametric Drafter, generate the final OpenSCAD code using the Architect's JSON Spec below. Remember to use Additive-First construction.
    
Architect Spec:
${JSON.stringify(state.assemblySpec, null, 2)}
`;

    const messages: BaseMessage[] = [
      new SystemMessage(CAD_AI_SYSTEM_PROMPT),
      ...state.messages,
      new AIMessage(state.explanation),
      new HumanMessage(drafterPrompt)
    ];

    let response = await drafterModel.invoke(messages, config);

    // Handle tool execution loop if the model requests engineering modules
    if (response.tool_calls && response.tool_calls.length > 0) {
      const toolCallMessages: BaseMessage[] = [response];

      for (const toolCall of response.tool_calls) {
        if (toolCall.name === 'get_functional_cad_module') {
          const moduleKey = (toolCall.args as any)?.moduleKey || 'fastener_hardware';
          onProgress?.({
            type: 'thinking',
            message: `Parametric Drafter: Retrieving tested engineering module: ${moduleKey}...`,
            timestamp: Date.now(),
          });

          const toolResult = await getFunctionalCadModuleTool.invoke(toolCall.args as any);
          toolCallMessages.push(
            new ToolMessage({
              tool_call_id: toolCall.id || `tool-${Date.now()}`,
              name: toolCall.name,
              content: typeof toolResult === 'string' ? toolResult : JSON.stringify(toolResult),
            })
          );
        }
      }

      onProgress?.({
        type: 'generating',
        message: 'Synthesizing complete parametric OpenSCAD script with retrieved engineering modules...',
        timestamp: Date.now(),
      });

      // Synthesize final code with tool observations
      response = await model.invoke([...messages, ...toolCallMessages], config);
    }

    const content = typeof response.content === 'string' ? response.content : JSON.stringify(response.content);
    const extractedCode = extractOpenScadCode(content);

    return {
      currentCode: extractedCode || '',
      explanation: state.explanation + "\n\n" + content,
      attemptCount: 1,
    };
  }

  // Node 3: validateCode
  async function validateCode(state: AgentStateType): Promise<Partial<AgentStateType>> {
    onProgress?.({
      type: 'validating',
      message: 'Physical Validator: Checking watertightness and flat-pack capabilities in WASM...',
      timestamp: Date.now(),
    });

    if (!state.currentCode) {
      return {
        isValid: false,
        validationError: 'No valid OpenSCAD code block found in response.',
      };
    }

    const validation = await validateOpenScadCode(state.currentCode);

    if (validation.valid && validation.stl) {
      return {
        isValid: true,
        validationError: null,
        stlContent: validation.stl,
      };
    } else {
      return {
        isValid: false,
        validationError: validation.error || 'Unknown compilation error.',
      };
    }
  }

  // Node 4: fixCode
  async function fixCode(state: AgentStateType, config?: RunnableConfig): Promise<Partial<AgentStateType>> {
    const currentAttempt = state.attemptCount + 1;

    onProgress?.({
      type: 'fixing',
      message: `Physical Validator Error. Drafter self-repairing solid model (attempt ${currentAttempt}/3)...`,
      timestamp: Date.now(),
    });

    const fixPrompt = `The OpenSCAD code produced a compilation or geometry error:
Error:
${state.validationError}

Current Broken Code:
\`\`\`openscad
${state.currentCode}
\`\`\`

Please diagnose the issue and provide the COMPLETE fixed OpenSCAD code in a single \`\`\`openscad ... \`\`\` block. Ensure all geometry is watertight, variables are declared, the Overlap Rule (+0.02mm) is respected for differences, and syntax is valid.`;

    const fixMessages = [
      new SystemMessage(CAD_AI_SYSTEM_PROMPT),
      ...state.messages,
      new AIMessage(state.explanation),
      new HumanMessage(fixPrompt),
    ];

    const response = await model.invoke(fixMessages, config);
    const content = typeof response.content === 'string' ? response.content : JSON.stringify(response.content);
    const extractedCode = extractOpenScadCode(content);

    return {
      currentCode: extractedCode || state.currentCode,
      explanation: content,
      attemptCount: currentAttempt,
    };
  }

  // Node 5: respondToUser
  async function respondToUser(state: AgentStateType): Promise<Partial<AgentStateType>> {
    if (state.isValid) {
      onProgress?.({
        type: 'ready',
        message: 'Mechanical model compiled and verified successfully! 3D preview is ready.',
        code: state.currentCode,
        stl: state.stlContent || undefined,
        explanation: state.explanation,
        timestamp: Date.now(),
      });
    } else {
      onProgress?.({
        type: 'error',
        message: `Unable to automatically resolve compilation error: ${state.validationError}`,
        code: state.currentCode,
        explanation: state.explanation,
        timestamp: Date.now(),
      });
    }

    return {};
  }

  // Conditional Edge: route from validateCode
  function checkValidationRoute(state: AgentStateType) {
    if (state.isValid) {
      return 'respondToUser';
    }
    if (state.attemptCount < 3) {
      return 'fixCode';
    }
    return 'respondToUser';
  }

  // Build the graph
  const workflow = new StateGraph(AgentState)
    .addNode('architectNode', architectNode)
    .addNode('drafterNode', drafterNode)
    .addNode('validateCode', validateCode)
    .addNode('fixCode', fixCode)
    .addNode('respondToUser', respondToUser)
    .addEdge(START, 'architectNode')
    .addEdge('architectNode', 'drafterNode')
    .addEdge('drafterNode', 'validateCode')
    .addConditionalEdges('validateCode', checkValidationRoute, {
      fixCode: 'fixCode',
      respondToUser: 'respondToUser',
    })
    .addEdge('fixCode', 'validateCode')
    .addEdge('respondToUser', END);

  return workflow.compile();
}
