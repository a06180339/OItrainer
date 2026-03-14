/* competitions.js - 比赛模拟引擎
   重构后的比赛系统：采用逐步模拟（每10分钟一次tick）的方式计算学生解题过程
   
   核心概念：
   - 每道题有3-5档部分分（subtask），难度递增
   - 学生在每个时间片(10分钟)进行：选题 -> 思考/尝试 -> 可能跳题
   - 分数实时累积，最终得到比赛总分
   
   时间流逝：网页1秒 = 比赛10分钟
   
   比赛时长：
   - CSP-S1: 120分钟 (12个tick)
   - CSP-S2/NOIP: 240分钟 (24个tick)
   - 省选/NOI: 480分钟 (48个tick)
*/

(function(global){
  'use strict';

  // 比赛时长配置（分钟）
  const CONTEST_DURATION = {
    'CSP-S1': 120,
    'CSP-S2': 240,
    'NOIP': 240,
    '省选': 480,
    'NOI': 480,
    'IOI': 480
  };

  const TICK_INTERVAL = 10; // 每个tick代表10分钟

  /* ========== 部分分（Subtask）生成 ========== */
  /**
   * 为一道题生成部分分档位
   * @param {number} totalScore - 题目总分（通常100）
   * @param {number} problemDifficulty - 题目难度值
   * @returns {Array} subtasks - [{score, difficulty}]
   */
  /**
   * 生成题目的部分分档位
   * @param {number} totalScore
   * @param {number} problemDifficulty
   * @param {number|null} thinkingBase
   * @param {number|null} codingBase
   * @param {Object} options - 可选项 {forceSingle: boolean, numSubtasks: number}
   */
  function generateSubtasks(totalScore, problemDifficulty, thinkingBase=null, codingBase=null, options={}){
    const forceSingle = options && options.forceSingle;
    // 支持指定subtask数量（例如IOI的15个测试点）
    const specifiedNum = options && options.numSubtasks;
    const numSubtasks = forceSingle ? 1 : 
                        (specifiedNum && specifiedNum > 0) ? specifiedNum :
                        (3 + Math.floor(getRandom() * 3)); // 1 或 3-5 档 或 指定数量
    const subtasks = [];
    
    for(let i = 1; i <= numSubtasks; i++){
      let score, difficulty;
      
      if(numSubtasks === 1){
        // 强制单档：只有满分档
        score = totalScore;
        difficulty = problemDifficulty;
      } else if(i === numSubtasks){
        // 最后一档：满分，难度=题目难度
        score = totalScore;
        difficulty = problemDifficulty;
      } else {
        // 第x档：将总分按 numSubtasks 均匀分割，前面档位为累计分数阈值
        // 例如 numSubtasks=5 => 20,40,60,80,100；numSubtasks=15 则会平分为 6-7 分级
        score = Math.floor(totalScore * i / numSubtasks);
        // 难度递增：使用指数曲线分布，确保各档难度差距足够大
        // 第1档约为题目难度的35%，之后呈指数递增到100%
        const progress = i / numSubtasks; // 0到1之间的进度
        // 使用平方函数使难度增长更陡峭：0.35 + 0.65 * progress^1.8
        const difficultyRatio = 0.35 + 0.65 * Math.pow(progress, 1.8);
        difficulty = Math.floor(problemDifficulty * difficultyRatio);
      }

      // 生成思维/代码专用难度：优先基于每题的 thinkingBase/codingBase（若提供），否则基于基础 difficulty 再加 bonus
      // 不对思维/代码难度进行上限限制，允许超过 100，以适应高难度比赛
      let thinkingDifficultyBase = (typeof thinkingBase === 'number') ? thinkingBase : difficulty;
      let codingDifficultyBase = (typeof codingBase === 'number') ? codingBase : difficulty;
      
      // 对于多档题目，前面的档位应该降低难度（使用档位进度调整）
      if(numSubtasks > 1 && i < numSubtasks){
        const progress = i / numSubtasks;
        // 使用与score类似的指数曲线：前面档位难度更低
        const difficultyScale = 0.35 + 0.65 * Math.pow(progress, 1.8);
        thinkingDifficultyBase = Math.floor(thinkingDifficultyBase * difficultyScale);
        codingDifficultyBase = Math.floor(codingDifficultyBase * difficultyScale);
      }
      
      // 应用难度加成
      let thinkingDifficulty = thinkingDifficultyBase * (1.0 + (typeof THINKING_DIFFICULTY_BONUS === 'number' ? THINKING_DIFFICULTY_BONUS : 0.0));
      let codingDifficulty = codingDifficultyBase * (1.0 + (typeof CODING_DIFFICULTY_BONUS === 'number' ? CODING_DIFFICULTY_BONUS : 0.0));
      
      // 确保难度不为0（最小值为1）
      thinkingDifficulty = Math.max(1, Math.floor(thinkingDifficulty));
      codingDifficulty = Math.max(1, Math.floor(codingDifficulty));

      subtasks.push({ score, difficulty, thinkingDifficulty, codingDifficulty });
    }
    
    return subtasks;
  }

  /* ========== 学生比赛状态 ========== */
  class StudentContestState {
    constructor(student, problems){
      this.student = student;
      this.problems = problems.map(p => ({
        id: p.id,
        tags: p.tags,
        subtasks: p.subtasks,
        currentSubtask: 0, // 当前尝试的档位索引
        maxScore: 0, // 该题已获得的最高分
        solved: false, // 是否已AC（获得满分）
        attemptedSubtasks: new Set() // 已尝试过的子任务索引集合
      }));
      this.currentTarget = null; // 当前目标题目id
      this.totalScore = 0;
      this.thinkingTime = 0; // 当前题目已思考时间（分钟）
      this.recentlySkippedProblems = new Set(); // 最近跳过的题目ID集合，暂时不做
    }

    // 获取题目状态
    getProblem(id){
      return this.problems.find(p => p.id === id);
    }

    // 更新题目得分
    updateScore(problemId, newScore){
      const prob = this.getProblem(problemId);
      if(!prob) return;
      
      if(newScore > prob.maxScore){
        this.totalScore += (newScore - prob.maxScore);
        prob.maxScore = newScore;
        
        // 检查是否AC
        const lastSubtask = prob.subtasks[prob.subtasks.length - 1];
        if(newScore >= lastSubtask.score){
          prob.solved = true;
        }
      }
    }

    // 获取未完成的题目列表
    // 优先返回未跳过的题目，如果所有未完成题目都被跳过了，则清空跳过列表
    getUnsolvedProblems(){
      const unsolved = this.problems.filter(p => !p.solved);
      
      // 如果没有未完成的题目，直接返回
      if(unsolved.length === 0) return [];
      
      // 过滤掉最近跳过的题目
      const notSkipped = unsolved.filter(p => !this.recentlySkippedProblems.has(p.id));
      
      // 如果有未跳过的题目，返回它们
      if(notSkipped.length > 0) return notSkipped;
      
      // 如果所有未完成的题目都被跳过了，清空跳过列表，允许重新选择
      this.recentlySkippedProblems.clear();
      return unsolved;
    }
  }

  /* ========== 比赛模拟器 ========== */
  class ContestSimulator {
    constructor(contestConfig, students, game){
      this.config = contestConfig; // {name, duration, problems:[{id,tags,difficulty,maxScore}]}
      this.game = game;
      this.students = students.map(s => new StudentContestState(s, contestConfig.problems));
      this.currentTick = 0;
      this.maxTicks = Math.floor(contestConfig.duration / TICK_INTERVAL);
      this.isRunning = false;
      this.tickCallbacks = []; // GUI更新回调
      this.finishCallbacks = [];
      this.logs = []; // 比赛日志：记录技能发动、重要事件等
      this.logCallbacks = []; // 日志回调（用于实时显示）
    }

    // 添加日志条目
    addLog(message, type = 'info', studentName = null){
      const log = {
        tick: this.currentTick,
        time: this.currentTick * TICK_INTERVAL, // 比赛时间（分钟）
        message: message,
        type: type, // 'info', 'talent', 'solve', 'select', 'skip'
        studentName: studentName,
        timestamp: Date.now()
      };
      this.logs.push(log);
      
      // 触发日志回调
      for(let cb of this.logCallbacks){
        try{
          cb(log);
        }catch(e){
          console.error('Log callback error:', e);
        }
      }
    }

    // 注册日志回调
    onLog(callback){
      this.logCallbacks.push(callback);
    }

    // 注册tick回调（用于GUI更新）
    onTick(callback){
      this.tickCallbacks.push(callback);
    }

    // 注册完成回调
    onFinish(callback){
      this.finishCallbacks.push(callback);
    }

    // 开始模拟
    start(){
      this.isRunning = true;
      // initialize per-contest constmental for each student (copy of base mental)
      for(let st of this.students){
        const s = st.student;
        try{
          s._talent_state = s._talent_state || {};
          if(typeof s._talent_state.constmental === 'undefined'){
            s._talent_state.constmental = Number(s.mental || 50);
          }
        }catch(e){ /* ignore */ }
      }

      // 触发比赛开始事件（供天赋使用）
      for(let st of this.students){
        const s = st.student;
        if(typeof s.triggerTalents === 'function'){
          try{ 
            // expose current tick and totalTicks to talent handlers via state
            // attach tick info to the actual state object so prototype methods remain available
            Object.assign(st, { tick: this.currentTick, totalTicks: this.maxTicks });
            const results = s.triggerTalents('contest_start', { contestName: this.config.name, state: st }) || [];
            if(results && results.length){
              for(const r of results){ if(r.result) this.addLog(r.result, 'talent', s.name); }
            }
          }catch(e){ console.error('triggerTalents contest_start', e); }
        }
      }
      this.runTick();
    }

    // 暂停模拟
    pause(){
      this.isRunning = false;
    }

    // 单次tick模拟
    runTick(){
      if(!this.isRunning || this.currentTick >= this.maxTicks){
        this.finish();
        return;
      }

      // 对每个学生进行一次模拟
      for(let state of this.students){
        this.simulateStudentTick(state);
      }

      this.currentTick++;

      // 触发GUI回调
      for(let cb of this.tickCallbacks){
        try{
          cb(this.currentTick, this.maxTicks, this.students);
        }catch(e){
          console.error('Tick callback error:', e);
        }
      }

      // 继续下一tick（1秒后）
      if(this.isRunning){
        setTimeout(() => this.runTick(), 1000);
      }
    }

    // 模拟单个学生的一个时间片
    simulateStudentTick(state){
      const s = state.student;
      
      // 1. 选题阶段 - 强制选题，不允许停留在"未选题"状态
      const needsNewTarget = state.currentTarget === null || 
                             state.getProblem(state.currentTarget)?.solved;
      
      if(needsNewTarget){
        const selected = this.selectProblem(state, s);
        if(selected === null){
          // 所有题目都已完成，学生本轮无操作
          this.addLog(`${s.name} 已完成所有题目`, 'info', s.name);
          return;
        }
        state.currentTarget = selected;
        state.thinkingTime = 0;
        
        // 添加选题日志
        this.addLog(`${s.name} 开始做 T${selected + 1}`, 'select', s.name);
        
        // 触发选题事件（供天赋系统使用）
        if(typeof s.triggerTalents === 'function'){
            // ensure state has current tick info while preserving its prototype methods
            Object.assign(state, { tick: this.currentTick, totalTicks: this.maxTicks });
            const talentResults = s.triggerTalents('contest_select_problem', {
            contestName: this.config.name,
            problemId: selected,
            state: state
          });
          // 将天赋触发结果记录到日志
          if(talentResults && talentResults.length > 0){
            for(let tr of talentResults){
              if(tr.result){
                this.addLog(tr.result, 'talent', s.name);
              }
            }
          }
        }
      }

      const prob = state.getProblem(state.currentTarget);
      if(!prob) {
        // 异常情况：题目不存在，强制重新选题
        state.currentTarget = null;
        return;
      }
      
      // 如果当前题目已经AC，清除目标并继续下一轮
      if(prob.solved){
        state.currentTarget = null;
        state.thinkingTime = 0;
        return;
      }

      state.thinkingTime += TICK_INTERVAL;

      // 触发思考事件
      if(typeof s.triggerTalents === 'function'){
        // ensure state has current tick info while preserving its prototype methods
        Object.assign(state, { tick: this.currentTick, totalTicks: this.maxTicks });
        const talentResults = s.triggerTalents('contest_thinking', {
          contestName: this.config.name,
          problemId: state.currentTarget,
          thinkingTime: state.thinkingTime,
          state: state
        });
        // 记录天赋触发并处理特殊 action（如卡卡就过了 -> auto_pass_problem）
        let talentAutoPassed = false;
        if(talentResults && talentResults.length > 0){
          for(let tr of talentResults){
            if(!tr || !tr.result) continue;
            const out = tr.result;
            // 如果返回对象并包含 action 字段，处理已知动作
            if(typeof out === 'object' && out.action === 'auto_pass_problem'){
              // 直接通过当前题的最后一档
              const lastSub = prob.subtasks[prob.subtasks.length - 1];
              if(lastSub){
                state.updateScore(state.currentTarget, lastSub.score);
                prob.currentSubtask = prob.subtasks.length;
                prob.solved = true;
                this.addLog(out.message || '卡卡就过了：直接通过此题', 'talent', s.name);
                talentAutoPassed = true;
              }
            } else {
              // 其它返回值，记录日志（字符串或对象的 message）
              if(typeof out === 'string') this.addLog(out, 'talent', s.name);
              else if(typeof out === 'object' && out.message) this.addLog(out.message, 'talent', s.name);
            }
          }
        }
        // 如果天赋已直接通过本题，则跳过后续尝试
        if(talentAutoPassed) return;
      }

      // 2. 尝试解题 - 智能选择子任务档位
      // 不再检查所有档位是否尝试过，允许反复尝试
      // 跳题完全由时间驱动（shouldSkipProblem）
      
      let subtaskIdxToTry;
      
      // 如果学生为激进（talent 标记），则只尝试最后一档
      if(s.hasTalent && s.hasTalent('激进')){
        subtaskIdxToTry = prob.subtasks.length - 1;
      } else {
        // 传入思考时间，以便在卡题时调整策略
        subtaskIdxToTry = this.selectBestSubtask(s, prob, state.thinkingTime);
      }
      
      // 如果 selectBestSubtask 返回 null，说明没有可用档位，强制跳题
      if(subtaskIdxToTry === null){
        this.addLog(`${s.name} 没有可尝试的档位，放弃 T${state.currentTarget + 1}`, 'skip', s.name);
        state.currentTarget = null;
        state.thinkingTime = 0;
        return;
      }
      
      const subtask = prob.subtasks[subtaskIdxToTry];

      // Ad-hoc 大师 已在 talent handler 中可能直接调用 updateScore，检查是否已改变
      const beforeMax = prob.maxScore;
      const success = this.attemptSubtask(s, prob, subtask);

      // 如果学生为激进且成功通过最后一档，设置 currentSubtask 为最后档之后（标记为已尝试）

      if(success){
        // 成功通过该档位
        state.updateScore(state.currentTarget, subtask.score);
        
        // 不再标记已尝试，因为允许反复尝试
        // 但通过后可以尝试更高档位或继续当前档位（由 selectBestSubtask 决定）
        
        // 如果题目已AC，标记为完成
        if(prob.solved){
          prob.currentSubtask = prob.subtasks.length;
        }
        
        // 添加通过部分分日志
        const isAC = prob.solved;
        if(isAC){
          this.addLog(`${s.name} AC了 T${state.currentTarget + 1}！得分：${subtask.score}`, 'solve', s.name);
        } else {
          this.addLog(`${s.name} 通过了 T${state.currentTarget + 1} 的第 ${subtaskIdxToTry + 1} 档，得分：${subtask.score}`, 'info', s.name);
        }
        
        // 触发通过档位事件
        if(typeof s.triggerTalents === 'function'){
          Object.assign(state, { tick: this.currentTick, totalTicks: this.maxTicks });
          // 最小化：将当前题目的主知识点映射为 knowledge_* 键，供天赋（如 知识熔炉）读取
          let knowledgeType = null;
          try{
            const solvedProb = prob; // prob 是当前题目的状态对象，包含 tags
            const tags = Array.isArray(solvedProb && solvedProb.tags) ? solvedProb.tags : [];
            if(tags.includes('数据结构')) knowledgeType = 'knowledge_ds';
            else if(tags.includes('图论')) knowledgeType = 'knowledge_graph';
            else if(tags.includes('字符串')) knowledgeType = 'knowledge_string';
            else if(tags.includes('数学')) knowledgeType = 'knowledge_math';
            else if(tags.includes('DP')) knowledgeType = 'knowledge_dp';
          }catch(e){ knowledgeType = null; }

          const talentResults = s.triggerTalents('contest_pass_subtask', {
            contestName: this.config.name,
            problemId: state.currentTarget,
            subtaskIdx: subtaskIdxToTry,
            score: subtask.score,
            state: state,
            knowledgeType: knowledgeType
          });
          // 记录天赋触发
          if(talentResults && talentResults.length > 0){
            for(let tr of talentResults){
              if(tr.result){
                this.addLog(tr.result, 'talent', s.name);
              }
            }
          }
        }

        // 如果AC了，触发过题事件
        if(prob.solved && typeof s.triggerTalents === 'function'){
          Object.assign(state, { tick: this.currentTick, totalTicks: this.maxTicks });
          const talentResults = s.triggerTalents('contest_solve_problem', {
              contestName: this.config.name,
              problemId: state.currentTarget,
              state: state
            });
          // 记录天赋触发
          if(talentResults && talentResults.length > 0){
            for(let tr of talentResults){
              if(tr.result){
                this.addLog(tr.result, 'talent', s.name);
              }
            }
          }
        }
      } else {
        // 未成功通过该档位，不标记为已尝试（允许反复尝试）
        // 添加失败日志，说明尝试了哪个档位但未通过
        this.addLog(`${s.name} 尝试 T${state.currentTarget + 1} 第 ${subtaskIdxToTry + 1} 档失败`, 'info', s.name);
        
        // 不再标记已尝试，允许学生反复尝试同一档位
        // prob.attemptedSubtasks.add(subtaskIdxToTry); // 移除此行
        
        // 3. 未成功，检查是否基于时间跳题
        const shouldSkip = this.shouldSkipProblem(state, s);
        if(shouldSkip){
          this.addLog(`${s.name} 在 T${state.currentTarget + 1} 上卡住太久，决定跳题`, 'skip', s.name);
          
          // 将当前题目标记为最近跳过，暂时不做（但不是永久跳过）
          state.recentlySkippedProblems.add(state.currentTarget);
          
          state.currentTarget = null;
          state.thinkingTime = 0;
          
          // 触发跳题事件
          if(typeof s.triggerTalents === 'function'){
            Object.assign(state, { tick: this.currentTick, totalTicks: this.maxTicks });
            const talentResults = s.triggerTalents('contest_skip_problem', {
              contestName: this.config.name,
              problemId: prob.id,
              state: state
            });
            // 记录天赋触发
            if(talentResults && talentResults.length > 0){
              for(let tr of talentResults){
                if(tr.result){
                  this.addLog(tr.result, 'talent', s.name);
                }
              }
            }
          }
        }
      }
    }

    // 选题策略（预留接口，可被天赋系统override）
    // 策略：概率性顺序开题，简单题被选中概率更高
    selectProblem(state, student){
      const unsolved = state.getUnsolvedProblems();
      if(unsolved.length === 0) return null;

      // 如果学生有“稳扎稳打”，则严格按顺序从最小 id 开始选择第一个未解的题
      if(student.hasTalent && student.hasTalent('稳扎稳打')){
        const ordered = unsolved.slice().sort((a,b)=>a.id - b.id);
        return ordered[0].id;
      }

      // 计算每个题目的权重
      const scored = unsolved.map(p => {
        // 获取该题最简单档位作为难度参考（不再过滤已尝试）
        const easiestSubtask = p.subtasks.reduce((min, st) => 
          (!min || st.difficulty < min.difficulty) ? st : min, null) || p.subtasks[0];
        
        const knowledge = this.getKnowledgeForProblem(student, p);
        const ability = student.getComprehensiveAbility ? student.getComprehensiveAbility() : 50;
        const effectiveAbility = ability + knowledge * 0.5;
        
        // 计算题目相对于学生能力的难度
        const difficultyGap = easiestSubtask.difficulty - effectiveAbility;
        
        // 基础评分：从能力匹配度开始
        let baseScore = 100;
        
        // 难度匹配度评分：简单题得分更高
        if(difficultyGap <= -20){
          // 非常简单的题目：高分（能力远超难度）
          baseScore += 80;
        } else if(difficultyGap <= 0){
          // 简单题目：较高分（能力略超难度）
          baseScore += 60;
        } else if(difficultyGap <= 20){
          // 适中题目：中等分（能力与难度相当）
          baseScore += 40;
        } else if(difficultyGap <= 40){
          // 较难题目：较低分（能力略低于难度）
          baseScore += 20;
        } else {
          // 很难题目：低分（能力远低于难度）
          baseScore += 10;
        }
        
        // 顺序开题倾向：靠前的题目获得额外权重
        // 题目0获得+40分，题目1获得+32分，题目2获得+24分...
        const positionBonus = 40 - (p.id * 8);
        baseScore += Math.max(0, positionBonus);
        
        // 确保权重为正数
        return { id: p.id, weight: Math.max(1, baseScore) };
      });

      // 按权重随机选择（轮盘赌选择）
      const totalWeight = scored.reduce((sum, item) => sum + item.weight, 0);
      let random = getRandom() * totalWeight;
      
      for(let item of scored){
        random -= item.weight;
        if(random <= 0){
          return item.id;
        }
      }
      
      // 兜底：返回第一个
      return scored[0].id;
    }

    // 智能选择子任务档位
    // 根据学生能力和子任务难度，选择最合适的档位尝试
    // 允许反复尝试同一档位，不再跟踪已尝试档位
    // 优化：当想不出正解时，主动降级考虑部分分
    // @param {number} thinkingTime - 当前题目已思考的时间（分钟），用于调整策略
    // 智能选择子任务档位 - 优化版本：部分分/暴力优先策略
    selectBestSubtask(student, prob, thinkingTime = 0){
      const subtasks = prob.subtasks;
      const availableSubtasks = subtasks.map((st, idx) => ({ subtask: st, idx: idx }));
      
      if(availableSubtasks.length === 0) return null;
      
      const knowledge = this.getKnowledgeForProblem(student, prob);
      const thinking = Number(student.thinking || 50);
      const coding = Number(student.coding || 50);
      const totalAbility = (thinking + coding) / 2 + knowledge * 0.4;

      // 计算比赛剩余时间百分比 (0-1)
      const remainingTime = this.getRemainingTime();
      const timeRatio = remainingTime / this.config.duration;

      const scored = availableSubtasks.map(item => {
        const st = item.subtask;
        const stIdx = item.idx;
        const thinkingDiff = Number(st.thinkingDifficulty || st.difficulty || 0);
        
        let weight = 0;

        // --- 核心策略 1：顺序尝试奖励 ---
        // 越靠前的档位（暴力分），初始权重越高。
        // 第 0 档获得最高基础分，以此类推。
        weight += (subtasks.length - stIdx) * 50;

        // --- 核心策略 2：已获得分数屏蔽 ---
        // 如果当前这档的分数已经拿到了，权重直接降为极低。
        if (prob.maxScore >= st.score) {
          weight -= 500;
        }

        // --- 核心策略 3：难度匹配度 ---
        const diffGap = thinkingDiff - totalAbility;
        if (diffGap < -10) {
          weight += 100; // 绰绰有余，极力推荐
        } else if (diffGap > 20) {
          weight -= 200; // 太难了，不建议尝试
        }

        // --- 核心策略 4：贪心修正（只有低难度时才看重分值） ---
        weight += st.score * 0.2;

        // --- 核心策略 5：时间压力/绝望时刻 ---
        // 比赛时间少于 20% 且该题还没得分，或者题目实在太难
        const isPanic = (timeRatio < 0.2 && prob.maxScore === 0) || (diffGap > 40);
        if (isPanic && stIdx === 0) {
          weight += 1000; // 强制去写最简单的暴力档
        }

        // --- 核心策略 6：激进性格修正 ---
        if(student.hasTalent && student.hasTalent('激进')){
          if(stIdx === subtasks.length - 1) weight += 300; // 激进者还是更看重满分
        }

        return { idx: stIdx, finalWeight: weight };
      });

      // 按权重降序排序
      scored.sort((a, b) => b.finalWeight - a.finalWeight);
      
      // 这里的逻辑保证了：
      // 1. 如果第0档没过，它的权重会因为“顺序奖励”而极高。
      // 2. 一旦过了第0档，它的权重会因为“已获得分数屏蔽”而变低，学生才会去看第1档。
      
      // 增加一点随机性，避免学生变成机器人（85% 选最优权重）
      if (getRandom() < 0.85) {
        return scored[0].idx;
      } else {
        const randIdx = Math.floor(getRandom() * Math.min(2, scored.length));
        return scored[randIdx].idx;
      }
    }

    // 尝试解决某个档位（返回是否成功）
    // 新逻辑：分为思维通过（基于 thinking + 知识 + 心理稳定性）和代码通过（基于 coding）
    // 仅当两者都通过时才算档位成功。
    attemptSubtask(student, problem, subtask){
      const knowledge = this.getKnowledgeForProblem(student, problem);
      const ability = student.getComprehensiveAbility ? student.getComprehensiveAbility() : 50;
      // Use per-contest constmental if available (set by ContestSimulator.start and talent handlers)
      let mental = 50;
      try{
        if(student && student._talent_state && typeof student._talent_state.constmental !== 'undefined'){
          mental = Number(student._talent_state.constmental || 50);
        } else if(typeof student.getMentalIndex === 'function'){
          mental = student.getMentalIndex();
        } else {
          mental = Number(student.mental || 50);
        }
      }catch(e){ mental = Number(student.mental || 50); }

      // 使用子档位的专用 thinkingDifficulty 与 codingDifficulty（若不存在，回退到 subtask.difficulty）
      const taskThinkingDifficulty = Number(subtask.thinkingDifficulty || subtask.difficulty || 0);
      const taskCodingDifficulty = Number(subtask.codingDifficulty || subtask.difficulty || 0);

      // ========== 知识点门槛机制 ==========
      // 计算知识点需求（基于题目难度的归一化值）
      // 知识点需求为题目难度的 30%-50%（根据难度动态调整）
      const knowledgeRequirement = Math.max(15, taskThinkingDifficulty * 0.35);
      
      // 知识点惩罚：如果知识点不足，会严重降低通过概率
      let knowledgePenalty = 1.0;
      if(knowledge < knowledgeRequirement){
        // 知识点差距越大，惩罚越重
        const knowledgeGap = knowledgeRequirement - knowledge;
        // 使用指数衰减：每差10点知识，通过率降低约40%
        knowledgePenalty = Math.exp(-knowledgeGap / 15.0);
        // 最低保留5%的通过可能（给天赋或运气留空间）
        knowledgePenalty = Math.max(0.05, knowledgePenalty);
      }

      // 思维能力判定（thinking）：降低知识点的直接加成，改为乘性门槛
      // 基础思维能力只获得少量知识加成（从2.0降低到0.5）
      const thinkingBase = Number(student.thinking || 50) + knowledge * 0.5;
      const thinkingGap = thinkingBase - taskThinkingDifficulty;
      let thinkingProb = 1.0 / (1.0 + Math.exp(-thinkingGap / 12.0)); // sigmoid, 更灵敏于思维差距

      // 心理影响：提高稳定性但不过度决定成败
      const thinkingStability = 0.75 + 0.25 * (mental / 100.0);
      thinkingProb = thinkingProb * thinkingStability;

      // 应用知识点门槛惩罚（乘性效果）
      thinkingProb = thinkingProb * knowledgePenalty;

      // 代码能力判定（coding）：同样降低知识加成并应用门槛
      // 代码能力的知识加成从0.8降低到0.3
      const codingBase = Number(student.coding || 50) + knowledge * 0.3;
      const codingGap = codingBase - taskCodingDifficulty;
      let codingProb = 1.0 / (1.0 + Math.exp(-codingGap / 12.0));      
      // coding 稳定性受心理影响较小，给出较窄区间
      const codingStability = 0.8 + 0.2 * (mental / 100.0);
      codingProb = codingProb * codingStability;

      // 应用知识点门槛惩罚（乘性效果）
      codingProb = codingProb * knowledgePenalty;

      // ====== 调用 contest_check_subtask 天赋（最小侵入） ======
      try{
        // thinking 检定前的天赋检查
        if(typeof student.triggerTalents === 'function'){
          const tRes = student.triggerTalents('contest_check_subtask', { difficulty: taskThinkingDifficulty, checkType: 'thinking' }) || [];
          for(const tr of tRes){
            const out = tr && tr.result ? tr.result : tr;
            if(!out) continue;
            if(typeof out === 'object' && out.action){
              if(out.action === 'boost_ability'){
                thinkingProb *= (1 + Number(out.amount || 0));
                if(out.message) this.addLog(out.message, 'talent', student.name);
              } else if(out.action === 'reduce_difficulty'){
                // treat reduce_difficulty as making the check easier: increase pass prob
                thinkingProb *= (1 + Number(out.amount || 0));
                if(out.message) this.addLog(out.message, 'talent', student.name);
              } else if(out.action === 'reduce_ability'){
                thinkingProb *= Math.max(0, (1 - Number(out.amount || 0)));
                if(out.message) this.addLog(out.message, 'talent', student.name);
              } else if(out.message){
                this.addLog(out.message, 'talent', student.name);
              }
            } else if(typeof out === 'string'){
              this.addLog(out, 'talent', student.name);
            }
          }
        } else if(typeof window !== 'undefined' && window.TalentManager && typeof window.TalentManager.handleStudentEvent === 'function'){
          const tRes = window.TalentManager.handleStudentEvent(student, 'contest_check_subtask', { difficulty: taskThinkingDifficulty, checkType: 'thinking' }) || [];
          for(const tr of tRes){
            const out = tr && tr.result ? tr.result : tr;
            if(!out) continue;
            if(typeof out === 'object' && out.action){
              if(out.action === 'boost_ability'){
                thinkingProb *= (1 + Number(out.amount || 0));
                if(out.message) this.addLog(out.message, 'talent', student.name);
              } else if(out.action === 'reduce_ability'){
                thinkingProb *= Math.max(0, (1 - Number(out.amount || 0)));
                if(out.message) this.addLog(out.message, 'talent', student.name);
              } else if(out.message){
                this.addLog(out.message, 'talent', student.name);
              }
            } else if(typeof out === 'string'){
              this.addLog(out, 'talent', student.name);
            }
          }
        }
      }catch(e){ console.error('contest_check_subtask talent (thinking) error', e); }

      try{
        // coding 检定前的天赋检查
        if(typeof student.triggerTalents === 'function'){
          const tRes2 = student.triggerTalents('contest_check_subtask', { difficulty: taskCodingDifficulty, checkType: 'coding' }) || [];
          for(const tr of tRes2){
            const out = tr && tr.result ? tr.result : tr;
            if(!out) continue;
            if(typeof out === 'object' && out.action){
              if(out.action === 'boost_ability'){
                codingProb *= (1 + Number(out.amount || 0));
                if(out.message) this.addLog(out.message, 'talent', student.name);
              } else if(out.action === 'reduce_difficulty'){
                // treat reduce_difficulty as making the check easier: increase pass prob
                codingProb *= (1 + Number(out.amount || 0));
                if(out.message) this.addLog(out.message, 'talent', student.name);
              } else if(out.action === 'reduce_ability'){
                codingProb *= Math.max(0, (1 - Number(out.amount || 0)));
                if(out.message) this.addLog(out.message, 'talent', student.name);
              } else if(out.message){
                this.addLog(out.message, 'talent', student.name);
              }
            } else if(typeof out === 'string'){
              this.addLog(out, 'talent', student.name);
            }
          }
        } else if(typeof window !== 'undefined' && window.TalentManager && typeof window.TalentManager.handleStudentEvent === 'function'){
          const tRes2 = window.TalentManager.handleStudentEvent(student, 'contest_check_subtask', { difficulty: taskCodingDifficulty, checkType: 'coding' }) || [];
          for(const tr of tRes2){
            const out = tr && tr.result ? tr.result : tr;
            if(!out) continue;
            if(typeof out === 'object' && out.action){
              if(out.action === 'boost_ability'){
                codingProb *= (1 + Number(out.amount || 0));
                if(out.message) this.addLog(out.message, 'talent', student.name);
              } else if(out.action === 'reduce_ability'){
                codingProb *= Math.max(0, (1 - Number(out.amount || 0)));
                if(out.message) this.addLog(out.message, 'talent', student.name);
              } else if(out.message){
                this.addLog(out.message, 'talent', student.name);
              }
            } else if(typeof out === 'string'){
              this.addLog(out, 'talent', student.name);
            }
          }
        }
      }catch(e){ console.error('contest_check_subtask talent (coding) error', e); }


      // 记录原始概率用于日志

      // 难度压制：如果整体 problem.difficulty 很高（远大于综合能力），减低两者概率
      try{
        // 降低知识点在有效能力计算中的权重（从2.0改为0.5）
        const effectiveAbility = ability + knowledge * 0.5;
        if(problem && typeof problem.difficulty === 'number' && problem.difficulty > 2.0 * effectiveAbility){
          thinkingProb *= 0.45;
          codingProb *= 0.45;
          const msg = `${student.name} 在 T${(problem.id||0) + 1} 触发 难度压制：题目难度 ${problem.difficulty} > 2× 综合能力 ${effectiveAbility.toFixed(1)}，思维/代码通过概率被压制`;
          this.addLog(msg, 'info', student.name);
        }
      }catch(e){ 
        console.error('难度压制检测错误:', e);
      }

      // 限定极值
      thinkingProb = Math.max(0.03, Math.min(0.98, thinkingProb));
      codingProb = Math.max(0.03, Math.min(0.98, codingProb));

      // 实际掷骰
      const thinkingPass = getRandom() < thinkingProb;
      const codingPass = getRandom() < codingProb;

      // 记录详细日志（便于调参）
      try{
        const tPct = (thinkingProb*100).toFixed(1);
        const cPct = (codingProb*100).toFixed(1);
        const kPenaltyPct = (knowledgePenalty*100).toFixed(1);
        let logMsg = `${student.name} 尝试 T${(problem.id||0)+1} 档位：思维通过 ${thinkingPass} (${tPct}%)，代码通过 ${codingPass} (${cPct}%)`;
        if(knowledgePenalty < 0.95){
          logMsg += `，知识点惩罚 ${kPenaltyPct}% (知识${knowledge.toFixed(1)}/需求${knowledgeRequirement.toFixed(1)})`;
        }
        this.addLog(logMsg, 'info', student.name);
      }catch(e){}

      return thinkingPass && codingPass;
    }

    // 跳题判断：基于时间而非尝试次数
    shouldSkipProblem(state, student){
      const prob = state.getProblem(state.currentTarget);
      if(!prob) return false;

      // 如果已经 AC 了，不需要跳，逻辑会自动切换下一题（在 simulateStudentTick 处理）
      if(prob.solved) return false;

      const remainingTime = this.getRemainingTime();
      
      // 策略：如果已经拿到了一些分（比如拿了 30 分暴力）
      if(prob.maxScore > 0){
        // 检查剩余的最高档难度
        const lastSub = prob.subtasks[prob.subtasks.length - 1];
        const ability = student.getComprehensiveAbility ? student.getComprehensiveAbility() : 50;
        
        // 如果正解难度远超能力，且在这题上已经耗时 30 分钟以上，果断跳走去开新题拿别的部分分
        if(state.thinkingTime > 50){
           return (state.thinkingTime) < uniform(50, 80); 
        }
      }

      // 通用的基于时间的跳题逻辑（保留并加强）
      const focusBonus = (student.hasTalent && student.hasTalent('专注')) ? 20 : 0;
      let timeLimit = 45 + focusBonus;
      
      // 如果还没得分，时间限制缩短，防止卡死
      if(prob.maxScore === 0) timeLimit = 35 + focusBonus;

      if(state.thinkingTime >= timeLimit){
        const skipProb = 0.4 + (state.thinkingTime - timeLimit) * 0.02;
        return getRandom() < skipProb;
      }

      return false;
    }
    // 获取学生对某题的知识值
    getKnowledgeForProblem(student, problem){
      if(!problem.tags || problem.tags.length === 0) return 0;
      
      let totalKnowledge = 0;
      for(let tag of problem.tags){
        if(typeof student.getKnowledgeByType === 'function'){
          totalKnowledge += student.getKnowledgeByType(tag);
        }
      }
      return totalKnowledge / problem.tags.length;
    }

    // 比赛结束
    finish(){
      // 防止重复调用
      if(this._finished){
        console.warn('Contest already finished, skipping duplicate finish()');
        return;
      }
      this._finished = true;
      
      this.isRunning = false;
      
      // 清理日志回调以释放内存
      try{
        this.logCallbacks = [];
        this.tickCallbacks = [];
      }catch(e){}
      
      // 在比赛结束时，先触发每个学生的 contest_finish（用于天赋清理），并记录触发日志
      for(let st of this.students){
        const s = st.student;
        if(typeof s.triggerTalents === 'function'){
          try{
            const results = s.triggerTalents('contest_finish', { contestName: this.config.name, state: st, score: st.totalScore }) || [];
            if(results && results.length){
              for(const r of results){ if(r.result) this.addLog(r.result, 'talent', s.name); }
            }
          }catch(e){ console.error('triggerTalents contest_finish', e); }
        }
      }
      
      // ========== 失误系统 ==========
      // 仅在NOIP、CSP-S2、省选比赛中生效
      const mistakeApplicableContests = ['NOIP', 'CSP-S2', '省选'];
      if(mistakeApplicableContests.includes(this.config.name)){
        this.applyMistakeSystem();
      }

      // 调用完成回调
      for(let cb of this.finishCallbacks){
        try{
          cb(this.students, this.config);
        }catch(e){
          console.error('Finish callback error:', e);
        }
      }

      // 尝试刷新游戏面板（如果存在 renderAll）以移除临时提升的可视化效果
      if(typeof window !== 'undefined' && typeof window.renderAll === 'function'){
        try{ window.renderAll(); }catch(e){ console.error('renderAll failed', e); }
      }
    }
    
    // 应用失误系统
    applyMistakeSystem(){
      const MISTAKE_BASE_PROBABILITY = (typeof window !== 'undefined' && window.MISTAKE_BASE_PROBABILITY) || 0.15;
      const MISTAKE_MIN_PROBABILITY = (typeof window !== 'undefined' && window.MISTAKE_MIN_PROBABILITY) || 0.02;
      const MISTAKE_CODING_FACTOR = (typeof window !== 'undefined' && window.MISTAKE_CODING_FACTOR) || 0.0013;
      const MISTAKE_MIN_PENALTY = (typeof window !== 'undefined' && window.MISTAKE_MIN_PENALTY) || 0.10;
      const MISTAKE_MAX_PENALTY = (typeof window !== 'undefined' && window.MISTAKE_MAX_PENALTY) || 1.00;
      const MISTAKE_REASONS = (typeof window !== 'undefined' && window.MISTAKE_REASONS) || [
        "边界条件处理不当", "数组越界", "忘记特判", "long long写成int"
      ];
      
      for(let st of this.students){
        const s = st.student;
        
        // 计算学生的失误概率（基于代码能力）
        const coding = Math.max(0, Math.min(200, Number(s.coding || 0))); // 限制在0-200范围
        const mistakeProbability = Math.max(
          MISTAKE_MIN_PROBABILITY,
          MISTAKE_BASE_PROBABILITY - coding * MISTAKE_CODING_FACTOR
        );
        
        // 遍历每道题，判断是否失误
        for(let prob of st.problems){
          // 只对已得分的题目进行失误判定
          if(!prob.maxScore || prob.maxScore <= 0) continue;
          
          // 失误判定
          if(getRandom() < mistakeProbability){
            // 计算失误扣分（10%-100%的分数）
            const penaltyRatio = MISTAKE_MIN_PENALTY + getRandom() * (MISTAKE_MAX_PENALTY - MISTAKE_MIN_PENALTY);
            const penalty = Math.floor(prob.maxScore * penaltyRatio);
            
            // 随机选择一个失误理由
            const reason = MISTAKE_REASONS[Math.floor(getRandom() * MISTAKE_REASONS.length)];
            
            // 记录失误信息（存储到题目状态中，供UI显示）
            prob.mistakePenalty = penalty;
            prob.mistakeReason = reason;
            prob.originalScore = prob.maxScore;
            
            // 扣除分数
            prob.maxScore = Math.max(0, prob.maxScore - penalty);
            st.totalScore = Math.max(0, st.totalScore - penalty);
            
            // 记录失误日志
            this.addLog(`${s.name} 在 T${prob.id + 1} 上失误：${reason}，扣除 ${penalty} 分`, 'skip', s.name);
            
            // 推送事件卡片
            try{
              if(typeof window !== 'undefined' && window.pushEvent){
                window.pushEvent({
                  name: '比赛失误',
                  description: `【${this.config.name}】${s.name} 在 T${prob.id + 1} 中，由于${reason}，挂分 ${penalty} 分`,
                  week: (window.game && window.game.week) || 0
                });
              }
            }catch(e){
              console.error('pushEvent failed', e);
            }
          }
        }
      }
    }

    // 获取当前进度百分比
    getProgress(){
      return (this.currentTick / this.maxTicks) * 100;
    }

    // 获取剩余时间（分钟）
    getRemainingTime(){
      return (this.maxTicks - this.currentTick) * TICK_INTERVAL;
    }
  }

  /* ========== 比赛配置构建器 ========== */
  /**
   * 从比赛定义创建比赛配置
   * @param {Object} contestDef - {name, difficulty, maxScore, numProblems, tags?}
   * @returns {Object} - {name, duration, problems}
   */
  function buildContestConfig(contestDef){
    const duration = CONTEST_DURATION[contestDef.name] || 240;
    const problems = [];

    for(let i = 0; i < contestDef.numProblems; i++){
      const problemScore = Math.floor(contestDef.maxScore / contestDef.numProblems);
      
      // 题目标签
      let tags = [];
      if(contestDef.tags && contestDef.tags[i]){
        tags = contestDef.tags[i];
      } else {
        // 默认随机标签
        const allTags = ["数据结构", "图论", "字符串", "数学", "动态规划"];
        const numTags = 1 + Math.floor(getRandom() * 2); // 1-2个标签
        for(let j = 0; j < numTags; j++){
          const tag = allTags[Math.floor(getRandom() * allTags.length)];
          if(!tags.includes(tag)) tags.push(tag);
        }
      }

      // 题目难度计算
      // 检测比赛类型：正式比赛 vs 网赛
      const isOnlineContest = contestDef.contestType === 'online';
      const isOfficialContest = !isOnlineContest && typeof COMPETITION_DIFFICULTY_FACTORS !== 'undefined' && COMPETITION_DIFFICULTY_FACTORS[contestDef.name];
      
      let rawProblemDifficulty, problemDifficulty;
      
      // 如果是正式比赛且有配置的难度系数
      if(isOfficialContest){
        const difficultyFactors = COMPETITION_DIFFICULTY_FACTORS[contestDef.name];
        if(difficultyFactors && difficultyFactors[i] !== undefined){
          const factor = difficultyFactors[i];
          const randomPerturbation = (getRandom() - 0.5) * 0.15; // ±7.5%的随机扰动
          const actualFactor = factor * (1.0 + randomPerturbation);
          rawProblemDifficulty = contestDef.difficulty * actualFactor;
        } else {
          // 默认方式
          rawProblemDifficulty = contestDef.difficulty + (i * 20) - 10 + Math.floor(getRandom() * 20);
        }
      } 
      // 如果是网赛且有配置的难度系数
      else if(isOnlineContest && contestDef.onlineContestType){
        const difficultyFactors = getOnlineContestDifficultyFactors(contestDef.onlineContestType, contestDef.numProblems);
        if(difficultyFactors && difficultyFactors[i] !== undefined){
          const factor = difficultyFactors[i];
          const randomPerturbation = (getRandom() - 0.5) * 0.15; // ±7.5%的随机扰动
          const actualFactor = factor * (1.0 + randomPerturbation);
          rawProblemDifficulty = contestDef.difficulty * actualFactor;
        } else {
          // 默认方式
          rawProblemDifficulty = contestDef.difficulty + (i * 20) - 10 + Math.floor(getRandom() * 20);
        }
      }
      else {
        // 默认方式：基于题号递增
        rawProblemDifficulty = contestDef.difficulty + (i * 20) - 10 + Math.floor(getRandom() * 20);
      }
      
      // 归一化到 0-100 范围，使用常量 DIFFICULTY_NORMALIZE_DIVISOR（定义在 constants.js）
      problemDifficulty = rawProblemDifficulty / (typeof DIFFICULTY_NORMALIZE_DIVISOR !== 'undefined' ? DIFFICULTY_NORMALIZE_DIVISOR : 4.0);
      // 不再限制上限为100，允许高难度题目超过100
      problemDifficulty = Math.max(1, Math.floor(problemDifficulty));  // 确保至少为1

      // 生成部分分
      // 为每题生成一个 skew，使得思维/代码难度在该题上有显著差异，但平均保持 problemDifficulty
      const maxSkew = 30; // 可调：表示两者最大偏差幅度；增大可产生更强的思维/代码冷热题
      const skew = Math.floor(uniformInt(-maxSkew, maxSkew));
      // 使用线性一次函数将归一化后的 problemDifficulty 映射到 thinking/coding 基数。
      // 斜率由 DIFFICULTY_TO_SKILL_SLOPE 控制（在 constants.js 中定义）。
      // 不对值进行上限截断，允许超过 100 以表现高难度的放大效应。
      const baseMapped = Math.floor(problemDifficulty * (typeof DIFFICULTY_TO_SKILL_SLOPE === 'number' ? DIFFICULTY_TO_SKILL_SLOPE : 1.0));
      let thinkingBase = baseMapped + skew;
      let codingBase = baseMapped - skew;
      // 轻微随机扰动，避免所有题严格对称
      thinkingBase = thinkingBase + Math.floor(getRandom()*5 - 2);
      codingBase = codingBase + Math.floor(getRandom()*5 - 2);
      
      // 确保思维和代码难度不为0（最小值为1）
      thinkingBase = Math.max(1, thinkingBase);
      codingBase = Math.max(1, codingBase);

      // 对于网赛（online）且非 洛谷月赛/ Ucup 的类型，强制只生成单档满分部分分
      let forceSingle = false;
      try{
        if(contestDef && contestDef.contestType === 'online'){
          const otc = contestDef.onlineContestType || '';
          if(otc !== '洛谷月赛' && otc !== 'Ucup') forceSingle = true;
        }
      }catch(e){ /* ignore */ }

      // 检查是否指定了subtask数量（如IOI的15个测试点）
      const numSubtasks = contestDef.subtasksPerProblem || null;
      const subtasks = generateSubtasks(problemScore, problemDifficulty, thinkingBase, codingBase, { 
        forceSingle: forceSingle,
        numSubtasks: numSubtasks
      });

      problems.push({
        id: i,
        tags: tags,
        difficulty: problemDifficulty,
        maxScore: problemScore,
        subtasks: subtasks
      });
    }
    // 为了保证“综合加权难度”随题号大体递增，但不改变总体数值分布（方差不变），
    // 在题目生成后按 difficulty 对题目集合进行稳定排序，然后重新分配 id。
    // 排序只改变题目的顺序，不改变难度值集合，因此方差保持不变。
    problems.sort((a,b) => a.difficulty - b.difficulty);
    for(let idx = 0; idx < problems.length; idx++){
      problems[idx].id = idx;
    }

    return {
      name: contestDef.name,
      duration: duration,
      problems: problems,
      originalDef: contestDef
    };
  }

  /**
   * 获取网赛的难度系数数组
   * @param {string} contestType - 网赛类型名称
   * @param {number} numProblems - 题目数量
   * @returns {Array<number>} - 难度系数数组
   */
  function getOnlineContestDifficultyFactors(contestType, numProblems){
    // Atcoder ABC: 7题，从40到160，难度递增
    if(contestType === "Atcoder-ABC"){
      // 基准难度120，题目难度范围 40-160
      // 系数计算：(目标难度 / 基准难度)
      // 40/120=0.33, 60/120=0.5, 80/120=0.67, 100/120=0.83, 120/120=1.0, 140/120=1.17, 160/120=1.33
      return [0.33, 0.5, 0.67, 0.83, 1.0, 1.17, 1.33];
    }
    
    // Atcoder ARC: 4题，从120到350，难度递增
    if(contestType === "Atcoder-ARC"){
      // 基准难度230，题目难度范围 120-350
      // 120/230=0.52, 200/230=0.87, 275/230=1.20, 350/230=1.52
      return [0.52, 0.87, 1.20, 1.52];
    }
    
    // Codeforces Div3: 5题，普及级难度(120)
    if(contestType === "Codeforces-Div3"){
      // 使用类似递增分布：0.4, 0.7, 1.0, 1.3, 1.6
      return [0.4, 0.7, 1.0, 1.3, 1.6];
    }
    
    // Codeforces Div2: 5题，NOIP级难度(230)
    if(contestType === "Codeforces-Div2"){
      // 使用类似递增分布：0.4, 0.7, 1.0, 1.3, 1.6
      return [0.4, 0.7, 1.0, 1.3, 1.6];
    }
    
    // Codeforces Div1: 5题，省选级难度(320)
    if(contestType === "Codeforces-Div1"){
      // 使用类似递增分布：0.4, 0.7, 1.0, 1.3, 1.6
      return [0.4, 0.7, 1.0, 1.3, 1.6];
    }
    
    // 洛谷月赛: 4题，NOIP级难度(230)
    if(contestType === "洛谷月赛"){
      // 使用类似 Div2 的分布，但4题：0.5, 0.8, 1.2, 1.5
      return [0.5, 0.8, 1.2, 1.5];
    }
    
    // Ucup: 4题，省选级难度(320)
    if(contestType === "Ucup"){
      // 使用类似 Div1 的分布，但4题：0.5, 0.8, 1.2, 1.5
      return [0.5, 0.8, 1.2, 1.5];
    }
    
    // 默认返回均匀分布
    const factors = [];
    for(let i = 0; i < numProblems; i++){
      factors.push(0.5 + (i * 0.5));
    }
    return factors;
  }

  /* ========== 导出到全局 ========== */
  const CompetitionEngine = {
    ContestSimulator,
    StudentContestState,
    buildContestConfig,
    generateSubtasks,
    CONTEST_DURATION,
    TICK_INTERVAL
  };

  if(typeof window !== 'undefined'){
    window.CompetitionEngine = CompetitionEngine;
  }

  global.CompetitionEngine = CompetitionEngine;

})(window);
