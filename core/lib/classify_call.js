const classifyCall = (call) => {
    // 1. Spam Check: Duration < 5 seconds
    // Note: Vapi duration is in seconds.
    let duration = call.duration || 0;
    if (!duration && call.startedAt && call.endedAt) {
        const start = new Date(call.startedAt);
        const end = new Date(call.endedAt);
        duration = (end - start) / 1000; // Convert ms to seconds
    }
    if (duration < 5) {
        return {
            category: 'spam',
            bookingStatus: 'none',
            transferReason: 'short-abandoned'
        };
    }

    // 2. DEFINITIVE Transfer Check: endedReason === 'assistant-forwarded-call'
    // This is PROOF the transfer succeeded - customer was connected to another department
    if (call.endedReason === 'assistant-forwarded-call') {
        const destination = call.destination?.description ||
            call.destination?.number ||
            'unknown-destination';
        return {
            category: 'transferred',
            bookingStatus: 'none',
            transferReason: destination
        };
    }

    // 3. DEFINITIVE Booking Check: Check structured outputs AND transcript phrases
    // This must come BEFORE hangup check because customers often hang up after booking
    const appointmentBooked = call.analysis?.artifact?.structuredOutputs
        ? Object.values(call.analysis.artifact.structuredOutputs)
            .find(output => output.name === 'Appointment Booked')?.result === true
        : false;

    // 3b. Check Vapi Analysis Success Evaluation (JSON string)
    let vapiSuccess = false;
    if (call.analysis?.successEvaluation) {
        try {
            // It might be a string or already an object
            const evalData = typeof call.analysis.successEvaluation === 'string'
                ? JSON.parse(call.analysis.successEvaluation)
                : call.analysis.successEvaluation;

            if (evalData.call_success === 'yes' ||
                evalData.final_outcome?.toLowerCase().includes('booked') ||
                evalData.final_outcome?.toLowerCase().includes('scheduled')) {
                vapiSuccess = true;
            }
        } catch (e) {
            // Ignore parsing errors
        }
    }

    const transcript = call.transcript || '';
    const messages = call.messages || [];
    const fullText = transcript + ' ' + messages
        .filter(m => m.role === 'assistant')
        .map(m => m.message)
        .join(' ');
    const lowerText = fullText.toLowerCase();

    const hasConfirmationPhrase =
        lowerText.includes('appointment is confirmed for') ||
        lowerText.includes('consultation is confirmed for') ||
        lowerText.includes('your appointment is confirmed') ||
        lowerText.includes('your consultation is confirmed');

    // If booking detected (either way), it's a BOOKING regardless of who hung up
    if (appointmentBooked || hasConfirmationPhrase || vapiSuccess) {
        return {
            category: 'booking-success',
            bookingStatus: 'booking-success',
            transferReason: 'none'
        };
    }

    // 4. Check for Transfer Intent (without forward confirmation)
    // If transfer was attempted BUT endedReason !== 'assistant-forwarded-call',
    // then the customer hung up BEFORE/DURING transfer = FAILED TRANSFER = HANGUP
    let transferDestination = null;

    // Check explicit toolCalls array if it exists
    if (call.toolCalls && Array.isArray(call.toolCalls)) {
        const transferTool = call.toolCalls.find(t =>
            t.function?.name === 'intent_transfer' ||
            t.function?.name === 'transfer_intent' ||
            t.function?.name === 'transferCall'
        );
        if (transferTool) {
            try {
                const args = JSON.parse(transferTool.function.arguments);
                transferDestination = args.destination;
            } catch (e) {
                transferDestination = 'Unknown Destination';
            }
        }
    }

    // Fallback: Check messages for tool calls if not found in top-level array
    if (!transferDestination && call.messages) {
        const toolCallMessage = call.messages.find(m =>
            m.role === 'tool_calls' ||
            (m.toolCalls && m.toolCalls.some(t =>
                t.function.name === 'intent_transfer' ||
                t.function.name === 'transfer_intent' ||
                t.function.name === 'transferCall'
            ))
        );

        if (toolCallMessage) {
            const tool = toolCallMessage.toolCalls.find(t =>
                t.function.name === 'intent_transfer' ||
                t.function.name === 'transfer_intent' ||
                t.function.name === 'transferCall'
            );
            if (tool) {
                try {
                    const args = JSON.parse(tool.function.arguments);
                    transferDestination = args.destination;
                } catch (e) {
                    transferDestination = 'Unknown Destination';
                }
            }
        }
    }

    // If transfer intent found BUT call didn't end with 'assistant-forwarded-call',
    // it means the transfer failed (customer hung up during transfer)
    if (transferDestination && call.endedReason !== 'assistant-forwarded-call') {
        return {
            category: 'hangup',
            bookingStatus: 'none',
            transferReason: `hung-up-during-transfer-to-${transferDestination}`
        };
    }

    // 5. Customer Hangup (no booking, no successful transfer)
    if (call.endedReason === 'customer-ended-call') {
        return {
            category: 'hangup',
            bookingStatus: 'none',
            transferReason: 'customer-hung-up'
        };
    }

    // 6. Assistant Ended Check: Needs LLM Analysis
    // If the assistant ended the call but it wasn't a booking or transfer,
    // it might be a polite decline, a wrong number handled gracefully, or a logic error.
    if (call.endedReason === 'assistant-ended-call') {
        return { needs_analysis: true };
    }

    // 8. Fallback: Needs LLM Analysis
    return { needs_analysis: true };
};

module.exports = { classifyCall };
