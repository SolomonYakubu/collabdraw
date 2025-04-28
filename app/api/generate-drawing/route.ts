import { NextRequest, NextResponse } from "next/server";
import {
  GoogleGenerativeAI,
  HarmCategory,
  HarmBlockThreshold,
} from "@google/generative-ai";
import { nanoid } from "nanoid";
import { io } from "socket.io-client";

/**
 * Attempts to repair malformed JSON by fixing common syntax errors
 * @param jsonText - The potentially malformed JSON string
 * @returns A possibly repaired JSON string
 */
function repairJsonString(jsonText: string): string {
  // Step 1: Basic cleanup
  let repairedJson = jsonText.trim();

  // Step 2: Fix common JSON formatting issues
  repairedJson = repairedJson
    // Fix trailing commas in objects and arrays
    .replace(/,\s*}/g, "}")
    .replace(/,\s*\]/g, "]")
    // Fix missing quotes around property names
    .replace(/(\{|\,)\s*([a-zA-Z0-9_]+)\s*:/g, '$1"$2":')
    // Fix single quotes used for strings (convert to double quotes)
    .replace(/'([^']*?)'/g, '"$1"')
    // Fix unescaped quotes in strings
    .replace(/"([^"\\]*?)\\?"([^"\\]*?)"/g, '"$1\\"$2"');

  // Step 3: Advanced repairs for more severe issues
  // Try to fix missing commas between objects in array
  repairedJson = repairedJson.replace(/}\s*{/g, "},{");

  // Fix missing quotes around property values that should be strings
  repairedJson = repairedJson.replace(
    /:\s*([a-zA-Z0-9#]+)(\s*[,}])/g,
    ':"$1"$2'
  );

  // Step 4: Ensure the string is properly wrapped in an array
  if (!repairedJson.startsWith("[")) {
    repairedJson = "[" + repairedJson;
  }
  if (!repairedJson.endsWith("]")) {
    repairedJson = repairedJson + "]";
  }

  return repairedJson;
}

/**
 * Advanced JSON repair function with multiple repair strategies
 * @param jsonText - The potentially malformed JSON string
 * @returns A possibly repaired JSON string or null if repair failed
 */
function advancedJsonRepair(jsonText: string): string | null {
  // Skip if already valid
  try {
    JSON.parse(jsonText);
    return jsonText; // Already valid
  } catch (error) {
    console.log("JSON is invalid, attempting repairs...");
  }

  // Strategy 1: Basic common JSON syntax fixes
  try {
    const basicRepaired = repairJsonString(jsonText);
    JSON.parse(basicRepaired);
    console.log("Basic JSON repair succeeded");
    return basicRepaired;
  } catch (error) {
    console.log("Basic repair failed, trying advanced strategies");
  }

  // Strategy 2: Try to extract valid JSON array from the text
  try {
    // Look for array-like patterns and extract them
    const arrayMatch = jsonText.match(/\[\s*\{[\s\S]*?\}\s*\]/);
    if (arrayMatch) {
      const extracted = arrayMatch[0];
      const basicRepaired = repairJsonString(extracted);
      JSON.parse(basicRepaired);
      console.log("Array extraction repair succeeded");
      return basicRepaired;
    }
  } catch (error) {
    console.log("Array extraction repair failed");
  }

  // Strategy 3: Try to build a valid array from any object-like structures
  try {
    // Find all object-like structures
    const objectMatches = Array.from(jsonText.matchAll(/\{[^{}]*\}/g));
    if (objectMatches && objectMatches.length > 0) {
      // Join all found objects into an array
      const objectsArray = `[${objectMatches.map((m) => m[0]).join(",")}]`;
      const repaired = repairJsonString(objectsArray);
      JSON.parse(repaired);
      console.log("Object collection repair succeeded");
      return repaired;
    }
  } catch (error) {
    console.log("Object collection repair failed");
  }

  // Strategy 4: Extreme case - try to manually construct objects from key-value patterns
  try {
    // This is a last resort that tries to find property:value patterns and rebuild objects
    const propValueMatches = jsonText.match(
      /["']?(\w+)["']?\s*:\s*["']?([^,"'{}[\]]+)["']?/g
    );
    if (propValueMatches && propValueMatches.length > 0) {
      // Group properties that seem to belong to the same object
      const properties = {};
      let currentTool = null;

      propValueMatches.forEach((match) => {
        const [prop, value] = match
          .split(":")
          .map((s) => s.trim().replace(/["']/g, ""));
        if (prop === "tool") {
          currentTool = value;
          properties[currentTool] = properties[currentTool] || {};
        }
        if (currentTool) {
          properties[currentTool][prop] = value;
        }
      });

      // Convert the grouped properties into an array of objects
      const objects = Object.values(properties);
      if (objects.length > 0) {
        const jsonArray = JSON.stringify(objects);
        console.log("Manual property extraction succeeded");
        return jsonArray;
      }
    }
  } catch (error) {
    console.log("Manual property extraction failed");
  }

  return null; // All repair attempts failed
}

// Gemini model name for multimodal capabilities
const MODEL_NAME = "gemini-2.5-flash-preview-04-17";

// Canvas dimensions - default values for the drawing area
const CANVAS_WIDTH = 1600;
const CANVAS_HEIGHT = 900;

// Get API key from environment variable (set this in your project's .env file)
const API_KEY = process.env.GEMINI_API_KEY;
// Server URL for collaboration
const SOCKET_SERVER_URL =
  process.env.NEXT_PUBLIC_SOCKET_SERVER_URL || "http://localhost:3001";

export async function POST(req: NextRequest) {
  try {
    // Check if API key is available
    if (!API_KEY) {
      console.error("Gemini API key not configured");
      return NextResponse.json(
        { error: "Gemini API key not configured" },
        { status: 500 }
      );
    }

    // Parse request body to get the prompt
    const body = await req.json();
    const { prompt, currentState, history, userId, roomId } = body;

    if (!prompt || typeof prompt !== "string") {
      return NextResponse.json(
        { error: "Prompt is required and must be a string" },
        { status: 400 }
      );
    }

    // Initialize the Gemini API client
    const genAI = new GoogleGenerativeAI(API_KEY);
    const model = genAI.getGenerativeModel({ model: MODEL_NAME });

    // Configure safety settings
    const safetySettings = [
      {
        category: HarmCategory.HARM_CATEGORY_HARASSMENT,
        threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE,
      },
      {
        category: HarmCategory.HARM_CATEGORY_HATE_SPEECH,
        threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE,
      },
      {
        category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT,
        threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE,
      },
      {
        category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT,
        threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE,
      },
    ];

    // Configure generation parameters
    const generationConfig = {
      temperature: 0.4, // Lower temperature for more deterministic results
      topK: 32,
      topP: 1,
      maxOutputTokens: 65536, // Allow for detailed shape descriptions
    };

    // Format current canvas state information
    let canvasStateDescription = "The canvas is currently empty.";
    let detailedCanvasState = "";

    if (
      currentState &&
      Array.isArray(currentState) &&
      currentState.length > 0
    ) {
      canvasStateDescription = `The canvas currently contains ${currentState.length} shapes:`;

      // Group shapes by type for better description
      const shapeCountByType = currentState.reduce((acc, shape) => {
        acc[shape.tool] = (acc[shape.tool] || 0) + 1;
        return acc;
      }, {});

      // Create summary of shape types
      const shapeTypeSummary = Object.entries(shapeCountByType)
        .map(
          ([type, count]) =>
            `${count} ${type.toLowerCase()}${count !== 1 ? "s" : ""}`
        )
        .join(", ");

      canvasStateDescription += ` ${shapeTypeSummary}.`;

      // Create detailed shape descriptions (limit to first 15 shapes to avoid token limits)
      detailedCanvasState = currentState
        .slice(0, 15)
        .map((shape, index) => {
          let description = `Shape ${index + 1}: ${shape.tool} at position (${
            shape.x
          }, ${shape.y})`;

          if (shape.fill && shape.fill !== "transparent") {
            description += ` with ${shape.fill} fill`;
          }

          if (shape.tool === "Text" && shape.text) {
            description += ` containing text: "${shape.text}"`;
          } else if (shape.width && shape.height) {
            description += ` with dimensions ${shape.width}×${shape.height}`;
          } else if (shape.tool === "Line" || shape.tool === "Arrow") {
            description += ` from (${shape.x1}, ${shape.y1}) to (${shape.x2}, ${shape.y2})`;
          }

          return description;
        })
        .join("\n");

      // If there are more shapes not detailed, add a note
      if (currentState.length > 15) {
        detailedCanvasState += `\n(and ${
          currentState.length - 15
        } more shapes not described in detail)`;
      }
    }

    try {
      console.log("Calling Gemini API with prompt:", prompt);

      // Prepare a context-enhanced prompt to provide canvas info and guidelines
      const enhancedPrompt = `
${prompt}

CANVAS DIMENSIONS: Width: Infinte, Height: Infinite
CURRENT CANVAS: ${canvasStateDescription}
${detailedCanvasState ? `\nDETAILS:\n${detailedCanvasState}` : ""}

IMPORTANT: Please respond with ONLY a syntactically valid JSON array. Do not include any explanation, markdown formatting, or text outside the JSON array.

Valid JSON requirements:
- Use double quotes (") for all strings and property names
- No trailing commas in arrays or objects
- All property names must be quoted
- String values must be quoted
- Numbers must NOT be quoted
- Proper use of square brackets [] for arrays and curly braces {} for objects

Valid shape objects must have these properties:
- "tool": One of "Square", "Circle", "Diamond", "Line", "Arrow", "Text", "Freehand"
- "x", "y": Position coordinates (coordinates should be within canvas dimensions: x: 0-${CANVAS_WIDTH}, y: 0-${CANVAS_HEIGHT})
- "width", "height": Size for shapes (20-300)
- "stroke": Color in hex format
- "fill": Color in hex format or "transparent"
- For Line/Arrow: Include "x1", "y1", "x2", "y2" coordinates (all within canvas dimensions)
- For Freehand: Include "points" array with EXACTLY this format: [x1,y1, x2,y2, x3,y3, ...] where each pair represents a point in the drawing path. Include at least 15-30 points for smooth curves.
- For Text: Include "text" property

Example of valid JSON format:
[
  {
    "tool": "Circle",
    "x": 400,
    "y": 300,
    "width": 100,
    "height": 100,
    "stroke": "#000000",
    "strokeWidth": 2,
    "fill": "transparent"
  },
  {
    "tool": "Freehand",
    "stroke": "#FF5733",
    "strokeWidth": 2,
    "fill": "transparent",
    "points": [100,100, 110,105, 120,115, 130,130]
  }
]

Guidelines:
1. Use diverse colors and vary stroke widths (1-3)
2. For complex elements, combine multiple shapes
3. If clearing is needed, include {"tool": "ClearCanvas"} first
4. Position new elements to complement existing ones, avoid overlap
5. Only modify requested elements, don't recreate the entire scene
6. For freehand drawings, ensure points create smooth, continuous paths with proper coordinates
7. Feel free to use the entire canvas area (Infinite Height, Infinite Width) for your drawings
`;

      // Initialize chat with history
      const chat = model.startChat({
        generationConfig,
        safetySettings,
        history: history || [],
      });

      // Send the enhanced prompt to the chat
      const result = await chat.sendMessage(enhancedPrompt);
      const text = result.response.text();

      console.log("Received response from Gemini API");

      // Extract the JSON from the response
      // The response might contain markdown code blocks or extra text
      // Using a more flexible regex to extract JSON array from different response formats
      let jsonText;

      // First try to extract from markdown code blocks
      const codeBlockMatch = text.match(/```(?:json)?\s*(\[[\s\S]*?\])\s*```/);
      if (codeBlockMatch && codeBlockMatch[1]) {
        jsonText = codeBlockMatch[1];
      } else {
        // If no code block, try to extract a raw JSON array
        const jsonArrayMatch = text.match(/\[\s*[\s\S]*?\]\s*(?!\])/);
        if (jsonArrayMatch) {
          jsonText = jsonArrayMatch[0];
        } else {
          // Last resort: look for anything that might be JSON
          const possibleJsonMatch = text.match(/\[\s*\{[\s\S]*?\}\s*\]/);
          jsonText = possibleJsonMatch ? possibleJsonMatch[0] : null;
        }
      }

      if (!jsonText) {
        console.error("Failed to extract JSON from response:", text);
        return NextResponse.json(
          {
            error: "Failed to parse AI response - no valid JSON found",
            rawResponse: text.substring(0, 500), // Include part of the response for debugging
          },
          { status: 500 }
        );
      }

      // Parse the JSON to validate it
      try {
        console.log(
          "Attempting to parse extracted JSON:",
          jsonText.substring(0, 200) + "..."
        );

        let shapes;

        // First attempt: Try parsing the extracted text directly
        try {
          shapes = JSON.parse(jsonText);
          console.log("JSON parsed successfully on first attempt");
        } catch (directParseError) {
          console.log("Direct JSON parsing failed, attempting repairs");

          // Second attempt: Try applying the advanced JSON repair function
          const repairedJson = advancedJsonRepair(jsonText);

          if (!repairedJson) {
            console.error("All JSON repair attempts failed");
            throw new Error("Failed to repair malformed JSON response");
          }

          try {
            shapes = JSON.parse(repairedJson);
            console.log("JSON parsed successfully after repair");
          } catch (repairedParseError) {
            console.error(
              "JSON parsing failed even after repair attempts:",
              repairedParseError
            );
            throw new Error("Failed to parse JSON even after repairs");
          }
        }

        // Validate that we got an array
        if (!Array.isArray(shapes)) {
          throw new Error("Response is not an array");
        }

        // Validate that the array contains at least one shape
        if (shapes.length === 0) {
          throw new Error("No shapes were generated");
        }

        // Validate each shape has the minimum required properties and fix if possible
        const validShapes = shapes
          .map((shape) => {
            // Basic shape validation
            if (!shape || typeof shape !== "object") {
              return null;
            }

            // Create a normalized version of the shape with default values
            const normalizedShape = { ...shape };

            // Ensure it has a valid tool property
            const validTools = [
              "Square",
              "Circle",
              "Diamond",
              "Line",
              "Arrow",
              "Text",
              "Freehand",
              "ClearCanvas",
            ];

            if (
              !normalizedShape.tool ||
              !validTools.includes(normalizedShape.tool)
            ) {
              return null;
            }

            // For ClearCanvas, no further validation needed
            if (normalizedShape.tool === "ClearCanvas") {
              return normalizedShape;
            }

            // Provide defaults for missing properties
            if (normalizedShape.x === undefined) normalizedShape.x = 0;
            if (normalizedShape.y === undefined) normalizedShape.y = 0;

            // Ensure shapes always have visible colors
            // If stroke is white or transparent, make it black for visibility
            if (
              !normalizedShape.stroke ||
              normalizedShape.stroke === "#ffffff" ||
              normalizedShape.stroke === "transparent"
            ) {
              normalizedShape.stroke = "#000000";
            }

            if (!normalizedShape.fill) normalizedShape.fill = "transparent";
            if (!normalizedShape.strokeWidth) normalizedShape.strokeWidth = 2;

            // For lines and arrows, ensure endpoint coordinates exist and are numbers
            if (
              normalizedShape.tool === "Line" ||
              normalizedShape.tool === "Arrow"
            ) {
              if (normalizedShape.x1 === undefined)
                normalizedShape.x1 = normalizedShape.x;
              if (normalizedShape.y1 === undefined)
                normalizedShape.y1 = normalizedShape.y;
              if (normalizedShape.x2 === undefined)
                normalizedShape.x2 = normalizedShape.x + 100;
              if (normalizedShape.y2 === undefined)
                normalizedShape.y2 = normalizedShape.y + 100;

              // Convert string coordinates to numbers
              if (typeof normalizedShape.x1 !== "number")
                normalizedShape.x1 =
                  parseFloat(normalizedShape.x1) || normalizedShape.x;
              if (typeof normalizedShape.y1 !== "number")
                normalizedShape.y1 =
                  parseFloat(normalizedShape.y1) || normalizedShape.y;
              if (typeof normalizedShape.x2 !== "number")
                normalizedShape.x2 =
                  parseFloat(normalizedShape.x2) || normalizedShape.x + 100;
              if (typeof normalizedShape.y2 !== "number")
                normalizedShape.y2 =
                  parseFloat(normalizedShape.y2) || normalizedShape.y + 100;
            }

            // For rectangular shapes, ensure width and height exist
            if (
              ["Square", "Circle", "Diamond", "Text"].includes(
                normalizedShape.tool
              )
            ) {
              if (normalizedShape.width === undefined)
                normalizedShape.width = 100;
              if (normalizedShape.height === undefined)
                normalizedShape.height = 100;

              // Convert string dimensions to numbers
              if (typeof normalizedShape.width !== "number")
                normalizedShape.width =
                  parseFloat(normalizedShape.width) || 100;
              if (typeof normalizedShape.height !== "number")
                normalizedShape.height =
                  parseFloat(normalizedShape.height) || 100;
            }

            // For freehand, ensure points array exists and has the right format
            if (normalizedShape.tool === "Freehand") {
              if (
                !Array.isArray(normalizedShape.points) ||
                normalizedShape.points.length < 4
              ) {
                // Create a simple default path if points are missing or invalid
                normalizedShape.points = [
                  normalizedShape.x,
                  normalizedShape.y,
                  normalizedShape.x + 10,
                  normalizedShape.y + 10,
                  normalizedShape.x + 20,
                  normalizedShape.y,
                ];
              }

              // Ensure all points are numbers
              normalizedShape.points = normalizedShape.points.map((p) =>
                typeof p !== "number" ? parseFloat(p) || 0 : p
              );
            }

            // For text, ensure it has a text property and visible color
            if (normalizedShape.tool === "Text") {
              // Ensure text content exists
              if (!normalizedShape.text) {
                normalizedShape.text =
                  normalizedShape.label || normalizedShape.content || "Text";
              }

              // Force text to have visible fill color (never white or transparent)
              normalizedShape.fill =
                normalizedShape.fill &&
                normalizedShape.fill !== "#ffffff" &&
                normalizedShape.fill !== "transparent"
                  ? normalizedShape.fill
                  : "#000000";

              // Set reasonable dimensions for text boxes if not provided
              if (!normalizedShape.width) normalizedShape.width = 120;
              if (!normalizedShape.height) normalizedShape.height = 60;

              // Set default font properties
              normalizedShape.fontSize = normalizedShape.fontSize || 18;
              normalizedShape.fontFamily =
                normalizedShape.fontFamily || "Arial, sans-serif";
            }

            return normalizedShape;
          })
          .filter(Boolean); // Remove any null values

        if (validShapes.length === 0) {
          throw new Error("All shapes were invalid after validation");
        }

        console.log(
          `Successfully parsed ${validShapes.length} shapes from Gemini response`
        );

        // Add unique IDs to all shapes and creator info for collaboration
        const processedShapes = validShapes.map((shape) => ({
          ...shape,
          id: `ai_${nanoid(10)}`,
          createdBy: "ai",
          userId: userId || "ai",
        }));

        // If we have roomId and userId, broadcast to all connected users in the room
        if (roomId && userId) {
          try {
            // Connect to socket server to broadcast the shapes
            const socket = io(SOCKET_SERVER_URL, {
              query: { roomId, userId, userTag: "AI Assistant" },
              transports: ["websocket"],
              timeout: 5000,
            });

            socket.on("connect", () => {
              console.log("Socket connected for AI shape broadcasting");
              // Broadcast the shapes to everyone in the room
              socket.emit("canvas-update", {
                roomId,
                userId,
                shapes: processedShapes,
                isPartial: false,
              });

              // Disconnect after sending
              setTimeout(() => {
                socket.disconnect();
              }, 1000);
            });

            socket.on("connect_error", (err) => {
              console.error("Socket connection error in AI route:", err);
            });
          } catch (socketError) {
            console.error("Failed to broadcast AI shapes:", socketError);
            // Continue anyway - we'll still return the shapes to the requester
          }
        }

        return NextResponse.json({ shapes: processedShapes }, { status: 200 });
      } catch (parseError) {
        console.error("Failed to parse JSON from Gemini response:", parseError);
        console.error("Raw text:", text);

        return NextResponse.json(
          {
            error: "Failed to parse drawing data: " + parseError.message,
            rawResponse: text.substring(0, 500), // Include part of the response for debugging
          },
          { status: 500 }
        );
      }
    } catch (apiError) {
      console.error("Error calling Gemini API:", apiError);

      // Extract the most useful error information
      const errorMessage =
        apiError instanceof Error ? apiError.message : "Unknown API error";

      return NextResponse.json(
        { error: `Error from Gemini API: ${errorMessage}` },
        { status: 500 }
      );
    }
  } catch (error) {
    console.error("Unexpected error in generate-drawing API route:", error);

    return NextResponse.json(
      {
        error:
          "Failed to generate drawing: " +
          (error instanceof Error ? error.message : "Unknown error"),
      },
      { status: 500 }
    );
  }
}
