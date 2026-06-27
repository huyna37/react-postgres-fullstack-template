const { llmGenerate, getSmartModel, getFastModel } = require('./llm');

const getSystemPrompt = (role) => `
Bạn là một AI Business Analyst chuyên nghiệp với Kỹ năng Phân tích Ngữ cảnh (Context Intelligence Skill). Nhiệm vụ của bạn là chuyển đổi các yêu cầu nghiệp vụ sơ khai thành các Jira ticket có cấu trúc rõ ràng và tối ưu nhất.

# Kỹ năng Phân tích Ngữ cảnh (Context Intelligence Skill):
1. **Trích xuất Thực thể**: Tự động nhận diện các đối tượng cốt lõi (Người dùng, Hệ thống, API, Component) trong yêu cầu.
2. **Lọc nhiễu (Token Reduction)**: Tự động loại bỏ các thông tin rác, câu chào hỏi, hoặc các nội dung lặp lại không mang giá trị nghiệp vụ.
3. **Phân loại logic**: Tự động phân định đâu là Yêu cầu nghiệp vụ (Business Need) và đâu là Ràng buộc kỹ thuật (Technical Constraint).
4. **Suy luận bối cảnh**: Nếu yêu cầu còn thiếu sót, hãy dựa trên Persona (${role}) để tự suy luận các tiêu chí chấp nhận (Acceptance Criteria) hợp lý nhất mà không cần hỏi lại.

# Nguyên tắc cốt lõi:
- Tập trung vào "CÁI GÌ" (yêu cầu nghiệp vụ) thay vì "LÀM THẾ NÀO" (giải pháp kỹ thuật chi tiết).
- Nội dung phải súc tích, mang tính bao quát và không rườm rà để tiết kiệm token.
- Sử dụng kết quả từ Skill Phân tích để xây dựng nội dung ticket trực diện nhất.

# Quy tắc về loại Ticket (Story):
Nếu loại ticket là "Story":
1. Sinh 1 ticket chính (Story).
2. Sinh 2 sub-tasks đi kèm:
   - [DEV]: Mô tả các hạng mục phát triển chính cần thực hiện.
   - [TEST]: Mô tả các kịch bản kiểm thử cơ bản (test cases).
Mỗi sub-task phải có "issueType": "Sub-task".

# Output Format:
Luôn trả về JSON duy nhất, không giải thích thêm.
Schema:
{
  "summary": "Tiêu đề ngắn gọn, súc tích",
  "description": "Mô tả bối cảnh và yêu cầu chính (Vấn đề, Hành vi mong đợi)",
  "issueType": "Story/Task/Bug...",
  "priority": "Medium/High...",
  "labels": [],
  "acceptanceCriteria": ["Tiêu chí 1", "Tiêu chí 2"],
  "technicalNotes": ["Lưu ý khái quát về hệ thống (nếu có)"],
  "subTickets": []
}

# Ngôn ngữ:
- Toàn bộ nội dung phải bằng tiếng Việt.
- Văn phong chuyên nghiệp, trực diện.
`;

const generateJiraTicket = async (context, role, assignee, ticketType, createAutoSubTasks, subTaskDevAssignee, subTaskTestAssignee) => {
  const subTaskInstruction = (ticketType === 'Story' && createAutoSubTasks)
    ? `Generate exactly 2 subTickets: one starting with "[DEV]" and one starting with "[TEST]". Each with "issueType": "Sub-task".`
    : `Do NOT generate any subTickets. Return an empty subTickets array: []`;

  const userPrompt = `
Persona/Role: ${role}
Main Ticket Type: ${ticketType}
Primary Assignee: ${assignee}
${createAutoSubTasks && subTaskDevAssignee ? `Assignee for [DEV] sub-task: ${subTaskDevAssignee}` : ''}
${createAutoSubTasks && subTaskTestAssignee ? `Assignee for [TEST] sub-task: ${subTaskTestAssignee}` : ''}
Business Context: ${context}

Sub-task instruction: ${subTaskInstruction}
`;

  try {
    const model = getSmartModel();
    const content = await llmGenerate(userPrompt, { systemInstruction: getSystemPrompt(role), model });
    
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('Invalid AI response');
    
    const ticket = JSON.parse(jsonMatch[0]);
    ticket.assignee = assignee; // Ensure assignee is set
    
    return ticket;
  } catch (error) {
    console.error('LLM Error:', error.message);
    throw error;
  }
};

const generateWorklogComment = async (summary, description) => {
  const prompt = `
  Bạn là một trợ lý AI giúp viết nội dung báo cáo công việc (Worklog comment) trên Jira.
  Dựa trên thông tin Ticket dưới đây, hãy viết một nội dung ngắn gọn (khoảng 1-3 câu) mô tả công việc đã hoàn thành để dùng làm Worklog comment.
  
  Tiêu đề ticket: ${summary}
  Mô tả ticket: ${description}
  
  Yêu cầu:
  - Ngôn ngữ: Tiếng Việt.
  - Văn phong: Chuyên nghiệp, trực diện vào hành động (VD: "Đã hoàn thành...", "Thực hiện xử lý...", "Phát triển tính năng...").
  - Trả về DUY NHẤT nội dung comment, không giải thích thêm.
  `;

  try {
    const model = getFastModel();
    const text = await llmGenerate(prompt, { model });
    return text.trim();
  } catch (error) {
    console.error('LLM Worklog Error:', error.message);
    throw error;
  }
};

const rewriteContent = async (fieldType, currentContent) => {
  const instruction = (fieldType.toLowerCase().includes('summary') || fieldType.toLowerCase().includes('tiêu đề'))
    ? '- Yêu cầu cực kỳ ngắn gọn, súc tích, đi thẳng vào vấn đề. Không quá 12 từ.'
    : '- Yêu cầu viết đầy đủ, chi tiết, trình bày rõ ràng bối cảnh và các hạng mục cần thiết.';

  const prompt = `
  Bạn là một chuyên gia Business Analyst và Project Manager.
  Hãy giúp tôi viết lại nội dung sau đây cho trường "${fieldType}" của một Jira Ticket.
  
  QUY TẮC:
  ${instruction}
  - Giữ nguyên ý nghĩa cốt lõi nhưng diễn đạt chuyên nghiệp và rõ ràng hơn.
  - Sử dụng thuật ngữ kỹ thuật/nghiệp vụ phù hợp.
  - Nếu là danh sách, hãy trình bày theo dạng các gạch đầu dòng.
  - Ngôn ngữ: Tiếng Việt.
  - Trả về DUY NHẤT nội dung đã được viết lại, không có lời dẫn hay giải thích.

  NỘI DUNG HIỆN TẠI:
  "${currentContent}"
  `;

  try {
    const model = getFastModel();
    const text = await llmGenerate(prompt, { model });
    return text.trim();
  } catch (error) {
    console.error('LLM Rewrite Error:', error.message);
    throw error;
  }
};

module.exports = { generateJiraTicket, generateWorklogComment, rewriteContent };
