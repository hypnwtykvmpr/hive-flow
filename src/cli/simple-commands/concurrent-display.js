/**
 * Concurrent Agent Display Manager
 * Provides a threaded view of multiple agents running in parallel
 */

export class ConcurrentDisplay {
  constructor(agents = [], options = {}) {
    this.agents = new Map();
    this.options = {
      maxWidth: process.stdout.columns || 120,
      updateInterval: 100,
      showTools: true,
      showTimers: true,
      ...options
    };
    
    // Initialize agent states
    agents.forEach(agent => {
      this.agents.set(agent.id, {
        ...agent,
        status: 'pending',
        currentTool: null,
        lastActivity: '',
        startTime: null,
        events: 0,
        progress: 0
      });
    });
    
    this.displayBuffer = [];
    this.lastRender = Date.now();
    this.spinnerFrames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
    this.spinnerIndex = 0;
  }

  /**
   * Start the display update loop
   */
  start() {
    // Clear screen and hide cursor
    console.log('\x1B[2J\x1B[H\x1B[?25l');
    
    this.interval = setInterval(() => {
      this.render();
    }, this.options.updateInterval);
    
    // Restore cursor on exit
    process.on('exit', () => {
      console.log('\x1B[?25h'); // Show cursor
      this.stop();
    });
  }

  /**
   * Stop the display updates
   */
  stop() {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    console.log('\x1B[?25h'); // Show cursor
  }

  /**
   * Update agent status
   */
  updateAgent(agentId, updates) {
    const agent = this.agents.get(agentId);
    if (agent) {
      Object.assign(agent, updates);
      if (updates.status === 'active' && !agent.startTime) {
        agent.startTime = Date.now();
      }
    }
  }

  /**
   * Add activity to agent
   */
  addActivity(agentId, activity, tool = null) {
    const agent = this.agents.get(agentId);
    if (agent) {
      agent.lastActivity = activity.substring(0, 50) + (activity.length > 50 ? '...' : '');
      agent.currentTool = tool;
      agent.events++;
      
      // Update progress based on activity
      if (activity.includes('completed') || activity.includes('finished')) {
        agent.progress = 100;
      } else if (agent.progress < 90) {
        agent.progress = Math.min(agent.progress + 5, 90);
      }
    }
  }

  /**
   * Render the display
   */
  render() {
    const now = Date.now();
    this.spinnerIndex = (this.spinnerIndex + 1) % this.spinnerFrames.length;
    const spinner = this.spinnerFrames[this.spinnerIndex];
    
    // Clear screen completely and move cursor to home position
    process.stdout.write('\x1B[2J\x1B[H');
    
    // Header
    this.renderHeader();
    
    // Agent panels
    this.renderAgentPanels(spinner);
    
    // Summary footer
    this.renderFooter();
    
    this.lastRender = now;
  }

  /**
   * Render header
   */
  renderHeader() {
    const width = this.options.maxWidth;
    console.log('╔' + '═'.repeat(width - 2) + '╗');
    console.log('║' + this.center('🤖 MLE-STAR CONCURRENT AGENT EXECUTION', width - 2) + '║');
    console.log('╠' + '═'.repeat(width - 2) + '╣');
  }

  /**
   * Render agent panels in columns
   */
  renderAgentPanels(spinner) {
    const agentArray = Array.from(this.agents.values());
    const columns = Math.min(3, agentArray.length); // Max 3 columns
    const columnWidth = Math.floor((this.options.maxWidth - 4) / columns) - 2;
    
    // Group agents by rows
    const rows = Math.ceil(agentArray.length / columns);
    
    for (let row = 0; row < rows; row++) {
      let line = '║ ';
      
      for (let col = 0; col < columns; col++) {
        const agentIndex = row * columns + col;
        if (agentIndex < agentArray.length) {
          const agent = agentArray[agentIndex];
          line += this.renderAgentPanel(agent, columnWidth, spinner);
          if (col < columns - 1) line += ' │ ';
        } else {
          line += ' '.repeat(columnWidth);
          if (col < columns - 1) line += ' │ ';
        }
      }
      
      line += ' ║';
      console.log(line);
      
      // Add separator between rows
      if (row < rows - 1) {
        let separator = '║ ';
        for (let col = 0; col < columns; col++) {
          separator += '─'.repeat(columnWidth);
          if (col < columns - 1) separator += ' │ ';
        }
        separator += ' ║';
        console.log(separator);
      }
    }
  }

  /**
   * Render individual agent panel
   */
  renderAgentPanel(agent, width, spinner) {
    const lines = [];
    
    // Agent header with icon and name
    const icon = this.getAgentIcon(agent.type);
    const statusIcon = this.getStatusIcon(agent.status, spinner);
    const header = `${icon} ${agent.name}`;
    lines.push(this.truncate(`${statusIcon} ${header}`, width));
    
    // Status line
    const status = this.getStatusText(agent.status);
    const elapsed = agent.startTime ? this.formatDuration(Date.now() - agent.startTime) : '--:--';
    lines.push(this.truncate(`Status: ${status} │ ${elapsed}`, width));
    
    // Progress bar
    if (agent.status === 'active') {
      lines.push(this.renderProgressBar(agent.progress, width));
    } else {
      lines.push(' '.repeat(width));
    }
    
    // Current activity
    if (agent.lastActivity) {
      lines.push(this.truncate(`→ ${agent.lastActivity}`, width));
    } else {
      lines.push(this.truncate('→ Waiting...', width));
    }
    
    // Tool usage
    if (agent.currentTool && this.options.showTools) {
      lines.push(this.truncate(`🔧 ${agent.currentTool}`, width));
    } else {
      lines.push(' '.repeat(width));
    }
    
    // Stats
    lines.push(this.truncate(`Events: ${agent.events}`, width));
    
    // Pad to consistent height
    while (lines.length < 6) {
      lines.push(' '.repeat(width));
    }
    
    return lines.join('\n║ ').split('\n').map(l => l.substring(2)).join('\n║ ');
  }

  /**
   * Render footer with summary
   */
  renderFooter() {
    const width = this.options.maxWidth;
    const agents = Array.from(this.agents.values());
    const active = agents.filter(a => a.status === 'active').length;
    const completed = agents.filter(a => a.status === 'completed').length;
    const failed = agents.filter(a => a.status === 'failed').length;
    const total = agents.length;
    
    console.log('╠' + '═'.repeat(width - 2) + '╣');
    
    const progress = total > 0 ? Math.floor((completed + failed) / total * 100) : 0;
    const summary = `📊 Progress: ${progress}% (${completed}/${total}) │ ⚡ Active: ${active} │ ✅ Done: ${completed} │ ❌ Failed: ${failed}`;
    console.log('║' + this.center(summary, width - 2) + '║');
    
    console.log('╚' + '═'.repeat(width - 2) + '╝');
  }

  /**
   * Helper methods
   */
  getAgentIcon(type) {
    const icons = {
      'search': '🔍',
      'foundation': '🏗️',
      'refinement': '🔧',
      'ensemble': '🎯',
      'validation': '✅',
      'coordinator': '🎮',
      'researcher': '🔬',
      'coder': '💻',
      'optimizer': '⚡',
      'architect': '🏛️',
      'tester': '🧪'
    };
    return icons[type] || '🤖';
  }

  getStatusIcon(status, spinner) {
    switch (status) {
      case 'active': return spinner;
      case 'completed': return '✅';
      case 'failed': return '❌';
      case 'pending': return '⏳';
      default: return '•';
    }
  }

  getStatusText(status) {
    switch (status) {
      case 'active': return 'Running';
      case 'completed': return 'Complete';
      case 'failed': return 'Failed';
      case 'pending': return 'Waiting';
      default: return status;
    }
  }

  renderProgressBar(progress, width) {
    const barWidth = Math.min(20, width - 10);
    const filled = Math.floor(progress / 100 * barWidth);
    const empty = barWidth - filled;
    return `[${'\u2588'.repeat(filled)}${'░'.repeat(empty)}] ${progress}%`;
  }

  truncate(text, width) {
    if (text.length <= width) {
      return text.padEnd(width);
    }
    return text.substring(0, width - 3) + '...';
  }

  center(text, width) {
    const padding = Math.max(0, width - text.length);
    const leftPad = Math.floor(padding / 2);
    const rightPad = padding - leftPad;
    return ' '.repeat(leftPad) + text + ' '.repeat(rightPad);
  }

  formatDuration(ms) {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    
    if (hours > 0) {
      return `${hours}h ${minutes % 60}m`;
    } else if (minutes > 0) {
      return `${minutes}m ${seconds % 60}s`;
    } else {
      return `${seconds}s`;
    }
  }
}

/**
 * Create a display manager for workflow agents
 */
export function createConcurrentDisplay(agents, options = {}) {
  return new ConcurrentDisplay(agents, options);
}