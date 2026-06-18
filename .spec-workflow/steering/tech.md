# Technical Standards & Decisions

## Core Technology Stack

### Programming Languages
- **Primary**: JavaScript (Node.js 18+) for all core functionality
- **Configuration**: JSON/YAML for configuration files
- **Scripts**: Bash for system administration and startup scripts
- **Documentation**: Markdown for all documentation

### Architecture Patterns

#### 1. Three-Layer Classification Architecture
**Pattern**: PathAnalyzer → KeywordMatcher → SemanticAnalyzer
- **Layer 1 (PathAnalyzer)**: <1ms response time, 100% accuracy for file operations
- **Layer 2 (KeywordMatcher)**: <10ms response time, fast keyword-based classification
- **Layer 3 (SemanticAnalyzer)**: <10ms response time, LLM-based deep understanding
- **Rationale**: Sequential layers provide increasing sophistication while maintaining performance
- **Implementation**: Each layer can short-circuit for immediate classification

#### 2. Agent-Agnostic Design Pattern
**Pattern**: Common interface across all AI coding assistants
- **MCP Integration**: Claude Code via Model Context Protocol
- **HTTP API Integration**: GitHub Copilot, Cursor, and others via REST endpoints
- **Unified Command Interface**: Same semantic analysis capabilities regardless of agent
- **Rationale**: Ensures consistent functionality and knowledge sharing across different AI tools

#### 3. Configuration-Driven Architecture
**Pattern**: Centralized configuration with environment-specific overrides
- **Main Config**: `config/live-logging-config.json` for core system settings
- **Environment Variables**: Runtime overrides for API keys, paths, and feature flags
- **Per-Project Config**: Project-specific settings in `.specstory/config/`
- **Rationale**: Enables deployment flexibility while maintaining consistent defaults

### Performance Standards

#### Response Time Requirements
- **File Path Analysis**: <1ms (Layer 1 classification)
- **Keyword Matching**: <10ms (Layer 2 classification)  
- **Semantic Analysis**: <10ms (Layer 3 classification)
- **End-to-End Classification**: <30ms total pipeline
- **Live Status Updates**: <100ms for status line updates
- **Real-Time Logging**: <100ms for session file updates

#### Resource Usage Standards
- **Memory Footprint**: <100MB constant usage for core services
- **CPU Utilization**: <5% during normal operation, <20% during intensive analysis
- **Disk I/O**: Minimize disk operations, use efficient batching for file writes
- **Network Usage**: Cache API responses, implement intelligent rate limiting

### API Integration Standards

#### LLM Provider Integration
**Primary Provider**: XAI/Grok (grok-2-1212)
- **Performance**: Custom inference chips provide <50ms response time
- **Cost**: $25/month free credits make it cost-effective for semantic analysis
- **Reliability**: Built-in fallback to OpenAI (gpt-4o-mini) and Anthropic (claude-3-haiku)

**Configuration Pattern**:
```json
{
  "semantic_analysis": {
    "models": {
      "xai": {
        "default_model": "grok-2-1212",
        "base_url": "https://api.x.ai/v1",
        "timeout": 10000,
        "rate_limit": { "requests_per_second": 1, "requests_per_hour": 60 }
      }
    }
  }
}
```

#### Rate Limiting Strategy
- **Aggressive Caching**: 30-second cache for API usage checks
- **Conservative Estimation**: Assume higher usage when actual data unavailable
- **Provider Failover**: Automatic fallback when primary provider exhausted
- **Request Batching**: Combine multiple analysis requests when possible

### Data Architecture

#### Knowledge Management System
**Multi-Database Architecture**: 
- **MCP Memory Service**: Runtime knowledge graph storage and querying
- **Topic-Specific Files**: `shared-memory-*.json` files for persistent storage
- **Automatic Sync**: Bidirectional synchronization between runtime and persistent storage

**Entity Structure**:
```javascript
{
  "name": "PatternName",
  "entityType": "TechnicalPattern | WorkflowPattern | TransferablePattern",
  "observations": [{
    "type": "problem | solution | metric | insight",
    "content": "Detailed description",
    "date": "ISO 8601 timestamp",
    "context": "Additional context"
  }],
  "significance": 1-10,
  "tags": ["tag1", "tag2"]
}
```

#### Live Session Logging Architecture
**Real-Time Processing Pipeline**:
1. **Transcript Monitor**: Polls Claude transcript files every 5 seconds
2. **Content Classification**: Three-layer analysis for intelligent routing
3. **Session Boundary Detection**: 60-minute time tranches with smart transitions
4. **Cross-Project Routing**: Content intelligently routed to appropriate knowledge domains

**File Naming Convention**:
```
2025-09-14_0800-0900_a1b2c3_from-nano-degree.md
[date]_[time-window]_[user-hash]_from-[source-project].md
```

### Security Standards

#### Comprehensive Secret Redaction System
**40+ Pattern Types**: API keys, database connections, personal info, corporate data
- **Environment Variables**: `ANTHROPIC_API_KEY=value` → `ANTHROPIC_API_KEY=<SECRET_REDACTED>`
- **JSON Structures**: `{"apiKey": "sk-123..."}` → `{"apiKey": "<SECRET_REDACTED>"}`
- **Connection Strings**: `mongodb://user:pass@host` → `mongodb://<CONNECTION_STRING_REDACTED>`
- **Context Preservation**: Maintain document structure while securing sensitive data

**Configuration-Driven Redaction**:
```yaml
redaction:
  categories:
    api_keys:
      enabled: true
      patterns: [...]
    personal_info:
      enabled: true
      patterns: [...]
    corporate_info:
      enabled: false  # Configurable per environment
```

#### Multi-User Security
- **USER Environment Hashing**: 6-digit SHA-256 hash prevents filename collisions
- **Project Isolation**: Content routing prevents cross-project data leakage
- **Access Control**: File permissions restrict access to appropriate users

### Development Standards

#### Code Quality Standards
- **ESLint Configuration**: Consistent code style across all JavaScript files
- **Error Handling**: Comprehensive try-catch blocks with contextual error messages
- **Logging Standards**: Structured logging with appropriate log levels
- **Documentation**: Inline JSDoc comments for all public functions

#### Testing Standards
**Comprehensive Testing Matrix**:
- **Unit Tests**: Individual component testing with mocked dependencies
- **Integration Tests**: End-to-end workflow testing with real data
- **Performance Tests**: Validation against timing requirements
- **Configuration Tests**: All configuration combinations and deployment scenarios

**Testing Framework**: Jest for JavaScript testing with custom test utilities

#### Version Control Standards
- **Git Workflow**: Feature branches with pull request reviews
- **Commit Messages**: Descriptive commits with proper categorization
- **Semantic Versioning**: Major.Minor.Patch versioning for releases
- **Branch Protection**: Require tests to pass before merging

### Integration Standards

#### MCP (Model Context Protocol) Integration
**Claude Code Primary Path**:
- **Transport**: stdio-based MCP server communication
- **Tools**: Direct access to semantic analysis, memory management, constraint monitoring
- **Reliability**: Process management with automatic restart capabilities

#### HTTP API Integration
**Alternative Agent Support**:
- **REST Endpoints**: Standard HTTP API for non-MCP agents
- **Authentication**: API key-based authentication for external integrations
- **Rate Limiting**: Per-client rate limiting to prevent abuse
- **Documentation**: OpenAPI specification for third-party integrations

#### File System Integration
**Cross-Platform Compatibility**:
- **Path Resolution**: Use Node.js `path` module for cross-platform path handling
- **Environment Variables**: Use placeholder-based paths for portability
- **Permissions**: Appropriate file permissions for multi-user environments

### Deployment Standards

#### Service Architecture
**Multiple Service Types**:
- **MCP Servers**: stdio-based servers for Claude Code integration
- **HTTP Services**: REST API servers for alternative agents
- **Background Workers**: Transcript monitoring and analysis services
- **Visualization**: Web servers for knowledge graph visualization

**Process Management**:
```json
{
  "services": ["transcript-monitor", "live-logging", "vkb-server", "semantic-analysis"],
  "pids": { "transcript-monitor": 12345, "live-logging": 12346 },
  "health_check": "periodic validation of service availability"
}
```

#### Environment Configuration
**Portable Installation**:
- **install.sh**: Cross-platform installation script with dependency detection
- **Placeholder Replacement**: Dynamic path resolution for different machines
- **Service Detection**: Automatic detection of available services and capabilities
- **Graceful Degradation**: System works with partial functionality when services unavailable

### Monitoring and Observability

#### Health Monitoring
- **Service Health Checks**: Regular validation of all running services
- **Performance Monitoring**: Real-time tracking of response times and resource usage
- **Error Tracking**: Comprehensive error logging with stack traces and context
- **Usage Analytics**: API usage tracking and cost monitoring

#### Debugging Standards
- **Debug Modes**: Environment variables enable detailed debugging output
- **Structured Logging**: JSON-formatted logs with consistent schemas
- **Test Utilities**: Scripts for testing individual components and workflows
- **Diagnostic Tools**: Health check commands and status reporting utilities

### Technology Choices Rationale

#### Why Node.js?
- **Ecosystem**: Rich npm ecosystem with excellent AI/ML libraries
- **Performance**: Event-driven architecture suitable for I/O intensive operations
- **JSON Native**: Natural fit for configuration and knowledge management
- **Cross-Platform**: Consistent behavior across macOS, Linux, Windows

#### Why Three-Layer Classification?
- **Performance**: Fast path analysis catches obvious cases immediately
- **Accuracy**: Semantic analysis provides high-quality classification for complex cases
- **Cost Efficiency**: Only use expensive LLM analysis when necessary
- **Reliability**: Multiple fallback layers ensure system always produces results

#### Why Agent-Agnostic Design?
- **Future-Proofing**: Support for new AI agents without architectural changes
- **User Choice**: Developers can use their preferred AI tools
- **Knowledge Continuity**: Same knowledge base benefits all agents
- **Market Reality**: AI agent landscape is rapidly evolving

### Migration and Backwards Compatibility

#### Configuration Migration
- **Version Detection**: Automatic detection of configuration format versions
- **Migration Scripts**: Automated migration of legacy configurations
- **Fallback Support**: Legacy format support during transition periods
- **Validation**: Comprehensive validation of migrated configurations

#### Data Migration
- **Schema Evolution**: Support for evolving knowledge base schemas
- **Data Preservation**: Zero data loss during system upgrades
- **Format Conversion**: Automatic conversion of legacy data formats
- **Rollback Capability**: Ability to revert to previous versions if needed

This technical foundation ensures the system is robust, scalable, and maintainable while providing excellent performance and developer experience.