const { OpenAI } = require("openai");

exports.handler = async (event, context) => {
  // CORS 헤더 설정
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
  };

  // OPTIONS 요청 처리 (CORS preflight)
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 200,
      headers,
      body: ''
    };
  }

  // Only allow POST
  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      headers,
      body: JSON.stringify({ error: "Method Not Allowed" })
    };
  }

  try {
    // 요청 본문 파싱
    let body;
    try {
      body = JSON.parse(event.body);
    } catch (parseError) {
      console.error("Failed to parse request body:", parseError);
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ 
          error: "잘못된 요청 형식입니다.", 
          score: 0, 
          feedback: "요청 데이터를 파싱할 수 없습니다." 
        })
      };
    }

    const { question, studentAnswer, rubric, correctAnswer, type } = body;

    // 필수 필드 검증
    if (!question || !studentAnswer || !type) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ 
          error: "필수 필드가 누락되었습니다.", 
          score: 0, 
          feedback: "문제, 답안, 유형 정보가 필요합니다." 
        })
      };
    }

    if (!process.env.OPENAI_API_KEY) {
      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({ error: "Missing OpenAI API Key", score: 0, feedback: "채점 서버 설정 오류입니다." })
      };
    }

    const openai = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
    });

    let prompt = "";

    if (type === 'essay') {
      // Parse rubric with points
      let rubricText = '';
      if (typeof rubric === 'string' && rubric.startsWith('{')) {
        try {
          const rubricObj = JSON.parse(rubric);
          rubricText = Object.entries(rubricObj).map(([k, v]) => {
            if (typeof v === 'object' && v.points && v.criteria) {
              return `- ${k}점 (배점: ${v.points}점): ${v.criteria}`;
            } else {
              return `- ${k}점: ${v}`;
            }
          }).join('\n');
        } catch (e) {
          rubricText = rubric;
        }
      } else {
        rubricText = rubric;
      }

      prompt = `
        You are a strict but fair teacher grading a student's answer. You must carefully analyze the student's actual response and compare it against the rubric criteria.
        
        Question: ${question}
        Model Answer (Reference): ${correctAnswer}
        
        Rubric (Scoring Criteria with Points): 
        ${rubricText}
        
        Student's Actual Answer: "${studentAnswer}"
        
        IMPORTANT INSTRUCTIONS:
        1. You MUST carefully read and analyze the student's actual answer content first.
        2. Compare the student's answer against EACH rubric criterion, checking what the student actually wrote.
        3. Evaluate how well the student's answer addresses the question and meets the rubric criteria.
        4. Assign a score based on how well the student's answer matches the rubric criteria (not just the model answer).
        5. Provide specific feedback that:
           - References specific parts of the student's answer
           - Explains which rubric criteria were met or not met
           - Suggests concrete improvements based on what the student actually wrote
           - Points out strengths in the student's answer if any
        
        CRITICAL FEEDBACK LENGTH REQUIREMENT:
        - The feedback must be concise and focused, between 150-250 characters (Korean characters).
        - Do NOT write lengthy paragraphs or multiple detailed explanations.
        - Be specific but brief, highlighting the most important points only.
        - Focus on the key strengths and weaknesses that directly relate to the rubric criteria.
        
        Your evaluation must be based on the STUDENT'S ACTUAL ANSWER CONTENT, not just comparing to the model answer.
        
        Output JSON format:
        {
          "score": number (must match one of the rubric point levels),
          "feedback": "string (concise feedback, 150-250 characters, referencing the student's answer)"
        }
      `;
    } else {
      // Fallback for logic if needed server-side, though usually frontend handles exact matches
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ message: "Simple types should be graded locally or via strict match." }),
      };
    }

    const completion = await openai.chat.completions.create({
      messages: [{ role: "system", content: "You are a helpful grading assistant." }, { role: "user", content: prompt }],
      model: "gpt-4o-mini", // Cost effective model
      response_format: { type: "json_object" },
    });

    const result = completion.choices[0].message.content;

    // 결과가 JSON 문자열인지 확인하고 파싱
    let parsedResult;
    try {
      parsedResult = JSON.parse(result);
    } catch (parseError) {
      console.error("Failed to parse OpenAI response:", parseError);
      console.error("Raw response:", result);
      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({ 
          error: "채점 결과 파싱 오류", 
          score: 0, 
          feedback: "채점 결과를 처리하는 중 오류가 발생했습니다." 
        })
      };
    }

    // 응답 형식 검증
    if (typeof parsedResult.score !== 'number' || typeof parsedResult.feedback !== 'string') {
      console.error("Invalid response format:", parsedResult);
      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({ 
          error: "채점 결과 형식 오류", 
          score: 0, 
          feedback: "채점 결과 형식이 올바르지 않습니다." 
        })
      };
    }

    // 피드백 길이 제한 (250자 초과 시 자동으로 잘라내기)
    let feedback = parsedResult.feedback;
    if (feedback.length > 250) {
      // 문장 단위로 자르기 (마지막 완전한 문장까지만 유지)
      const truncated = feedback.substring(0, 250);
      const lastPeriod = truncated.lastIndexOf('.');
      const lastQuestion = truncated.lastIndexOf('?');
      const lastExclamation = truncated.lastIndexOf('!');
      const lastSentenceEnd = Math.max(lastPeriod, lastQuestion, lastExclamation);
      
      if (lastSentenceEnd > 200) {
        feedback = truncated.substring(0, lastSentenceEnd + 1);
      } else {
        // 문장 끝을 찾지 못한 경우 그냥 250자로 자르기
        feedback = truncated + '...';
      }
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        score: parsedResult.score,
        feedback: feedback
      }),
    };

  } catch (error) {
    console.error("Error:", error);
    
    // 에러 타입에 따라 다른 메시지 반환
    let errorMessage = "채점 중 오류가 발생했습니다.";
    if (error.message) {
      if (error.message.includes('API key')) {
        errorMessage = "OpenAI API 키 오류입니다.";
      } else if (error.message.includes('rate limit')) {
        errorMessage = "요청 한도가 초과되었습니다. 잠시 후 다시 시도해주세요.";
      } else if (error.message.includes('timeout')) {
        errorMessage = "채점 요청 시간이 초과되었습니다. 다시 시도해주세요.";
      }
    }
    
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ 
        error: errorMessage,
        score: 0, 
        feedback: errorMessage 
      }),
    };
  }
};

