# Chapter 10: Testing, Quality & Fuzzing

In high-performance systems engineering, correctness and resilience are non-negotiable. While standard unit tests 
verify basic functional requirements, production-grade distributed daemons, storage engines, and network protocols 
require rigorous validation under concurrent multi-threaded stress, strict allocation budgeting, and malformed 
adversarial inputs.

This chapter explores advanced quality assurance in Go, covering advanced table-driven testing patterns, 
race-condition analysis with -race, high-performance benchmarking (`testing.B`), and native property-based fuzzing 
(testing.F) to harden zero-copy components like our MappedStore.

---

## 10.1 Table-Driven Testing & Race-Condition Validation

Table-driven tests are the gold standard for idiomatic Go testing, allowing engineers to isolate edge cases across
structured test vectors cleanly. However, when testing concurrent components or memory-mapped regions, standard 
assertions are insufficient. Systems code must be executed under Go's built-in race detector (go test -race), 
which instruments the compiler to intercept unauthorized concurrent memory accesses.

The following production-grade test suite validates record serialization, bounds checking, and atomic writes in MappedStore under concurrent stress.

```go
package main

import (
	"os"
	"sync"
	"testing"
	"unsafe"
)

// TestMappedStore_ConcurrentWritesAndReads validates concurrent atomic writes and memory persistence across multiple workers.
func TestMappedStore_ConcurrentWritesAndReads(test *testing.T) {
	// Create a temporary file for the memory-mapped backing store.
	temporaryFile, err := os.CreateTemp("", "store_test_*.db")

	if err != nil {
		test.Fatalf("failed to create temp file: %v", err)
	}

	defer os.Remove(temporaryFile.Name())
	defer temporaryFile.Close()

	// Initialize the memory-mapped store with a fixed virtual size.
	const storeSize = 1024 * 1024
	store, err := NewMappedStore(temporaryFile.Name(), storeSize)

	if err != nil {
		test.Fatalf("failed to initialize MappedStore: %v", err)
	}

	defer store.Close()

	// Configure concurrent workers and operations per worker.
	const workers = 4
	const opsPerWorker = 1000

	var waitGroup sync.WaitGroup

	// Launch concurrent worker goroutines to perform overlapping atomic writes.
	for workerIndex := 0; workerIndex < workers; workerIndex++ {
		waitGroup.Add(1)
		baseIndex := int64(workerIndex)

		go func(baseIndex int64) {
			defer waitGroup.Done()
			for needle := int64(0); needle < opsPerWorker; needle++ {
				index := (baseIndex * opsPerWorker) + needle
				record := Record{
					ID:        uint64(index),
					Timestamp: 1718712300 + index,
					Flags:     1,
				}

				// Write the record atomically into the memory-mapped segment.
				if err := store.WriteRecordAtomic(index, record); err != nil {
					test.Errorf("worker failed to write record at index %d: %v", index, err)
				}
			}
		}(baseIndex)
	}

	// Block until all concurrent write workers have finished executing.
	waitGroup.Wait()

	// Verify the persistence and integrity of all written records directly from memory.
	for index := int64(0); index < workers*opsPerWorker; index++ {
		offset := index * int64(unsafe.Sizeof(Record{}))
		destination := (*Record)(unsafe.Pointer(&store.memory[offset]))

		// Ensure the record ID matches the expected sequential index.
		if destination.ID != uint64(index) {
			test.Errorf("expected record ID %d at index %d, got %d", index, index, destination.ID)
		}
	}
}
```
---

## 10.2 High-Performance Benchmarking (testing.B) & Allocation Profiling

To prevent performance regressions in tight-loop data paths, systems engineers must measure execution speed 
and heap pressure using Go's benchmarking framework (`testing.B`).

A production-grade benchmark tracks operations per second alongside memory allocations (`AllocsPerOp()`), 
verifying that zero-copy implementations maintain an absolute target of **zero heap allocations per operation (allocs/op = 0).**

```go
package main

import (
	"os"
	"testing"
)

func BenchmarkMappedStore_WriteRecordAtomic(benchmark *testing.B) {
	// Create a temporary file for the memory-mapped benchmark store.
	temporaryFile, err := os.CreateTemp("", "bench_store_*.db")

	if err != nil {
		benchmark.Fatalf("failed to create temp file: %v", err)
	}

	defer os.Remove(temporaryFile.Name())
	defer temporaryFile.Close()

	// Initialize the memory-mapped store with a large backing size for benchmarking.
	const storeSize = 10 * 1024 * 1024
	store, err := NewMappedStore(temporaryFile.Name(), storeSize)

	if err != nil {
		benchmark.Fatalf("failed to initialize MappedStore: %v", err)
	}

	defer store.Close()

	// Construct a sample record payload to be written repeatedly.
	record := Record{
		ID:        999,
		Timestamp: 1718712300,
		Flags:     1,
	}

	// Configure the benchmark runner to report heap allocations per operation.
	benchmark.ReportAllocs()
	benchmark.ResetTimer()

	// Execute the write benchmark loop across benchmark.N iterations.
	for index := 0; index < benchmark.N; index++ {
		targetIndex := int64(index % 100000)
		_ = store.WriteRecordAtomic(targetIndex, record)
	}
}
```
---

### Use Unit Testing (`testing.T`) when:
- **Verifying Correctness:** You need to prove that a function, data structure, or concurrency primitive produces the expected output under valid, invalid, and edge-case inputs.
- **Catching Data Races:** You are validating multi-threaded access, lock synchronization, or memory-mapped regions using Go's race detector (go test -race).
- **Testing Failure Paths:** You need to ensure errors, out-of-bounds panics, and recovery routines trigger correctly under failure conditions.
- **Regression Prevention:** You are refactoring code and want to guarantee that existing business logic or protocol parsers remain functionally identical.

### Use Benchmarking (`testing.B`) when:
- **Measuring Throughput and Latency:** You are writing hot-path code (like MappedStore writes, network socket reads, or memory parsing) and need to measure operations per second or execution nanoseconds.
- **Enforcing Allocation Budgets:** You are optimizing zero-copy routines and need to track heap pressure using `b.ReportAllocs()` to guarantee your target of zero allocations per operation (`allocs/op = 0`).
- **Comparing Algorithmic Trade-offs:** You want to measure the performance delta between two implementation strategies (e.g., unsafe struct casting versus standard binary decoding).
- **Detecting Performance Regression:** You are tuning compiler optimizations, buffer sizes, or locking strategies and need hard metrics to confirm a change actually improved machine performance.

---

## 10.3 Go Lomb Coded Set Implementation & Unit Testing

`golombcodedset > arithmetic.go`

```go
// -----------------------------------------------------------------------------
// Package: golombcodedset
// File: arithmetic.go
//
// Description:
//
//	This file contains low-level arithmetic utilities used by the
//	Golomb-Coded Set implementation, including 128-bit multiplication
//	and fast range reduction without modulo bias.
//
// -----------------------------------------------------------------------------
package golombcodedset

// multiplyUint64 multiplies two 64-bit unsigned integers and returns the full
// 128-bit product as two 64-bit values.
// The returned values represent the high and low halves of the product,
// respectively. This function is used to implement fast range reduction
// without relying on platform-specific 128-bit integer support.
func multiplyUint64(multiplicand, multiplier uint64) (uint64, uint64) {
	const lowerMask = uint64(0xFFFFFFFF)

	// Split each 64-bit operand into 32-bit halves.
	multiplicandLow := multiplicand & lowerMask
	multiplicandHigh := multiplicand >> 32
	multiplierLow := multiplier & lowerMask
	multiplierHigh := multiplier >> 32

	// Compute all partial products from long multiplication.
	partialProductLowLow := multiplicandLow * multiplierLow
	crossProductLowHigh := multiplicandLow * multiplierHigh
	crossProductHighLow := multiplicandHigh * multiplierLow
	partialProductHighHigh := multiplicandHigh * multiplierHigh

	// Accumulate the carry generated by the lower 64-bit region.
	carry := (partialProductLowLow >> 32) +
		(crossProductLowHigh & lowerMask) +
		(crossProductHighLow & lowerMask)

	// Assemble the lower 64 bits of the 128-bit product.
	lower64Bits := (partialProductLowLow & lowerMask) | (carry << 32)

	// Assemble the upper 64 bits of the 128-bit product.
	upper64Bits := partialProductHighHigh +
		(crossProductLowHigh >> 32) +
		(crossProductHighLow >> 32) +
		(carry >> 32)

	return upper64Bits, lower64Bits
}

// fastRangeReduction maps a uniformly distributed 64-bit value into the range
// [0, rangeLimit) using multiplication-based reduction.
// The method avoids modulo bias and relies on the high 64 bits of the
// 128-bit product value * rangeLimit. A zero rangeLimit yields zero.
func fastRangeReduction(value uint64, rangeLimit uint64) uint64 {
	// A zero range produces a degenerate mapping and is treated
	// defensively by returning zero.
	if rangeLimit == 0 {
		return 0
	}

	// Multiply the input value by the range limit and return the
	// high 64 bits of the 128-bit product. This maps uniformly
	// distributed values into [0, rangeLimit) without modulo bias.
	upper64Bits, _ := multiplyUint64(value, rangeLimit)

	return upper64Bits
}
```
---

`golombcodedset > bit_stream_reader.go`

```go
// -----------------------------------------------------------------------------
// Package: golombcodedset
// File: bit_stream_reader.go
//
// Description:
//
//	This file defines a bit-level stream reader used for decoding
//	Golomb–Rice encoded values in a defensive and bounds-checked manner.
//
// -----------------------------------------------------------------------------
package golombcodedset

// bitStreamReader provides bit-level, least-significant-bit-first reading
// over a byte slice.
// It is used to decode Golomb–Rice encoded values in a defensive manner,
// ensuring bounds checks and safe termination on malformed input.
type bitStreamReader struct {
	buffer      []byte
	byteIndex   int
	currentByte uint8
	bitOffset   uint8
}

// newBitStreamReader constructs a new bit stream reader for the provided
// encoded bit buffer. The reader is initialized in a state that forces
// a byte fetch on the first bit read.
func newBitStreamReader(encodedBits []byte) *bitStreamReader {
	// Initialize the reader with the provided encoded bit buffer.
	// Setting bitOffset to 8 forces the first call to readSingleBit
	// to load a fresh byte from the buffer.
	return &bitStreamReader{
		buffer:    encodedBits,
		bitOffset: 8,
	}
}

// hasRemainingBits reports whether additional bits are available for reading
// from the underlying buffer.
func (reader *bitStreamReader) hasRemainingBits() bool {
	// If there are unread bytes remaining, bits are available.
	if reader.byteIndex < len(reader.buffer) {
		return true
	}

	// If all bytes have been consumed, bits may still remain
	// in the currently loaded byte.
	return reader.byteIndex == len(reader.buffer) && reader.bitOffset < 8
}

// remainingBits returns the total number of unread bits remaining in the
// underlying buffer, accounting for partially consumed bytes.
func (reader *bitStreamReader) remainingBits() uint64 {
	// Compute the total number of bits available in the buffer.
	// Each byte contributes exactly 8 bits.
	totalBits := uint64(len(reader.buffer)) * 8

	// Compute the number of bits fully consumed by advancing
	// past complete bytes.
	consumedBits := uint64(reader.byteIndex) * 8

	// If a byte has been loaded and partially consumed, account
	// for the number of bits already read from the current byte.
	// The byteIndex check ensures we do not count bits before any
	// byte has been loaded.
	if reader.bitOffset < 8 && reader.byteIndex > 0 {
		consumedBits += uint64(reader.bitOffset)
	}

	// If consumption has reached or exceeded the total available
	// bits, no bits remain to be read.
	if consumedBits >= totalBits {
		return 0
	}

	// Return the number of unread bits remaining in the stream.
	return totalBits - consumedBits
}

// readSingleBit reads and returns the next least-significant bit from the
// stream. The second return value reports whether the read was successful.
func (reader *bitStreamReader) readSingleBit() (uint8, bool) {
	// If all bits in the current byte have been consumed,
	// advance to the next byte in the buffer.
	if reader.bitOffset == 8 {
		// Ensure there is another byte available to read.
		// If not, the stream has been exhausted.
		if reader.byteIndex >= len(reader.buffer) {
			return 0, false
		}

		// Load the next byte from the buffer and reset the bit offset.
		reader.currentByte = reader.buffer[reader.byteIndex]
		reader.byteIndex++
		reader.bitOffset = 0
	}

	// Extract the current bit by shifting the byte right by the
	// current bit offset and masking the least significant bit.
	bit := (reader.currentByte >> reader.bitOffset) & 1

	// Advance the bit offset so the next call reads the next bit.
	reader.bitOffset++

	// Return the extracted bit and indicate a successful read.
	return bit, true
}

// readLeastSignificantBits reads the specified number of bits from the stream
// and assembles them into a uint64 value in least-significant-bit-first order.
// The function fails if the requested number of bits exceeds 63 or if the
// stream is exhausted.
func (reader *bitStreamReader) readLeastSignificantBits(bitCount uint8) (uint64, bool) {
	// Guard against invalid bit counts. Reading more than 63 bits
	// would overflow a uint64 when assembling the result.
	if bitCount > 63 {
		return 0, false
	}

	// Accumulator for the reconstructed value.
	// Bits are assembled in least-significant-bit-first order.
	var value uint64

	// Read the requested number of bits sequentially from the stream.
	for bitIndex := uint8(0); bitIndex < bitCount; bitIndex++ {
		// Read the next bit from the underlying bit stream.
		bit, ok := reader.readSingleBit()

		// Fail immediately if the stream is exhausted or malformed.
		if !ok {
			return 0, false
		}

		// Incorporate the bit into the result at the corresponding
		// bit position. The first bit read becomes bit 0, the next
		// bit 1, and so on.
		value |= uint64(bit) << bitIndex
	}

	// Successfully reconstructed the requested bit field.
	return value, true
}

// readUnaryEncodedValue decodes a unary-encoded integer from the stream.
// The value is represented as a sequence of one bits terminated by a zero bit.
// Decoding is bounded by the number of remaining bits to prevent infinite loops
// on malformed input.
func (reader *bitStreamReader) readUnaryEncodedValue() (uint64, bool) {
	var count uint64

	// Limit the maximum unary run length to the number of remaining
	// bits to avoid infinite loops on malformed input.
	maximumPossibleUnaryLength := reader.remainingBits()

	for count < maximumPossibleUnaryLength {
		// Read the next bit from the stream.
		bit, ok := reader.readSingleBit()

		if !ok {
			return 0, false
		}

		// A zero bit terminates the unary code.
		if bit == 0 {
			return count, true
		}

		// Each leading one increments the decoded value.
		count++
	}

	// Unary code did not terminate within the remaining bit budget.
	return 0, false
}

// readGolombRiceEncodedValue decodes a Golomb–Rice encoded value using the
// provided Rice parameter.
// The function returns the decoded value and a boolean indicating success.
func (reader *bitStreamReader) readGolombRiceEncodedValue(riceParameter uint8) (uint64, bool) {
	// The Rice parameter determines the split between unary quotient
	// and fixed-width remainder bits.
	if riceParameter > 63 {
		return 0, false
	}

	// Decode the unary-encoded quotient portion.
	quotient, ok := reader.readUnaryEncodedValue()

	if !ok {
		return 0, false
	}

	// Decode the fixed-width remainder portion.
	remainder, ok := reader.readLeastSignificantBits(riceParameter)

	if !ok {
		return 0, false
	}

	// Recombine quotient and remainder to form the original value.
	return (quotient << riceParameter) | remainder, true
}
```
---

`golombcodedset > bit_stream_writer.go`

```go
// -----------------------------------------------------------------------------
// Package: golombcodedset
// File: bit_stream_writer.go
//
// Description:
//
//	This file defines a bit-level stream writer used for encoding
//	Golomb–Rice values into a compact byte buffer.
//
// -----------------------------------------------------------------------------
package golombcodedset

// bitStreamWriter provides bit-level, least-significant-bit-first writing
// over a dynamically growing byte buffer.
// It is used to encode Golomb–Rice values during set construction.
type bitStreamWriter struct {
	buffer        []byte
	currentByte   uint8
	bitsInCurrent uint8
}

// newBitStreamWriter constructs a new bit stream writer with an initialized
// internal buffer.
func newBitStreamWriter() *bitStreamWriter {
	// Allocate a bit stream writer with an initial buffer capacity
	// to reduce reallocations during encoding.
	return &bitStreamWriter{
		buffer: make([]byte, 0, 128),
	}
}

// writeSingleBit writes a single bit to the stream. The bit is appended in
// least-significant-bit-first order.
// The function panics if the internal bit state becomes invalid, indicating
// a programmer error.
func (writer *bitStreamWriter) writeSingleBit(bit uint8) {
	// Guard against an invalid internal state. bitsInCurrent should
	// never exceed 7 prior to writing a new bit. Exceeding this
	// indicates a programmer error in bit accounting.
	if writer.bitsInCurrent >= 8 {
		panic("bit stream writer invalid bit state")
	}

	// If the bit value is non-zero, set the corresponding bit position
	// in the current output byte. Bits are written least-significant
	// bit first.
	if bit != 0 {
		writer.currentByte |= 1 << writer.bitsInCurrent
	}

	// Advance the bit position within the current byte.
	writer.bitsInCurrent++

	// If the current byte is now fully populated, flush it to the
	// output buffer and reset the byte accumulator state.
	if writer.bitsInCurrent == 8 {
		writer.buffer = append(writer.buffer, writer.currentByte)
		writer.currentByte = 0
		writer.bitsInCurrent = 0
	}
}

// writeLeastSignificantBits writes the specified number of least-significant
// bits from the provided value to the stream.
func (writer *bitStreamWriter) writeLeastSignificantBits(value uint64, bitCount uint8) {
	// Writing more than 63 bits would exceed uint64 capacity
	// and indicates invalid caller usage.
	if bitCount > 63 {
		return
	}

	// Emit bits starting from the least significant bit,
	// matching the LSB-first encoding convention used throughout.
	for bitIndex := uint8(0); bitIndex < bitCount; bitIndex++ {
		writer.writeSingleBit(uint8((value >> bitIndex) & 1))
	}
}

// writeUnaryEncodedValue writes a unary-encoded representation of the provided
// value to the stream.
func (writer *bitStreamWriter) writeUnaryEncodedValue(value uint64) {
	// Write a sequence of one bits equal to the value.
	for index := uint64(0); index < value; index++ {
		writer.writeSingleBit(1)
	}

	// Write the terminating zero bit to complete the unary code.
	writer.writeSingleBit(0)
}

// writeGolombRiceEncodedValue writes a Golomb–Rice encoded representation of
// the provided value using the specified Rice parameter.
func (writer *bitStreamWriter) writeGolombRiceEncodedValue(value uint64, riceParameter uint8) {
	// Reject invalid Rice parameters defensively.
	if riceParameter > 63 {
		return
	}

	// Split the value into a unary-encoded quotient and a
	// fixed-width remainder as defined by Golomb–Rice coding.
	quotient := value >> riceParameter
	remainder := value & ((uint64(1) << riceParameter) - 1)

	// Write the quotient followed by the remainder bits.
	writer.writeUnaryEncodedValue(quotient)
	writer.writeLeastSignificantBits(remainder, riceParameter)
}

// finalize flushes any partially written byte to the buffer and returns the
// complete encoded byte slice.
func (writer *bitStreamWriter) finalize() []byte {
	// If a partial byte is present, flush it to the buffer
	// so that no encoded bits are lost.
	if writer.bitsInCurrent != 0 {
		writer.buffer = append(writer.buffer, writer.currentByte)
	}

	// Return the complete encoded bitstream.
	return writer.buffer
}
```
---

`golombcodedset > go_lomb_coded_set.go`

```go
// -----------------------------------------------------------------------------
// Package: golombcodedset
// File: golomb_coded_set.go
//
// Description:
//
//	This file defines the core Golomb-Coded Set (GCS) data structure and its
//	public API. It is responsible for set construction, serialization,
//	deserialization, and membership queries over a static collection of
//	uniformly distributed 64-bit hash values.
//
//	Specifically, this file provides:
//	  - The GolombCodedSet type and its invariants
//	  - Binary marshaling and unmarshaling logic
//	  - Set construction via delta encoding and Golomb–Rice coding
//	  - Probabilistic membership testing logic
//
//	Low-level implementation details such as bit-level encoding/decoding and
//	arithmetic utilities are delegated to companion files within the same
//	package to maintain clear separation of responsibilities.
//
//	The Golomb-Coded Set supports false positives but guarantees no false
//	negatives, assuming uniformly distributed input hashes.
//
// Notes:
//   - Input values must already be uniformly distributed 64-bit hashes.
//   - This implementation favors correctness, clarity, and defensive decoding
//     over micro-optimizations.
//   - Malformed or truncated encodings are handled safely and cause lookups
//     to fail closed.
//
// -----------------------------------------------------------------------------
package golombcodedset

import (
	"encoding/binary"
	"errors"
	"sort"
)

// GolombCodedSet represents a space-efficient, probabilistic set supporting
// membership queries over a static collection of hashed values.
// The set is parameterized by a Rice parameter and stores delta-encoded,
// Golomb–Rice encoded values in a compact bitstream.
type GolombCodedSet struct {
	riceParameter uint8
	elementCount  uint32
	encodedBits   []byte
}

// MarshalBinary serializes the Golomb-Coded Set into a binary representation
// consisting of a header and the encoded bitstream.
func (set *GolombCodedSet) MarshalBinary() []byte {
	// Allocate space for the header and encoded payload.
	output := make([]byte, 0, 5+len(set.encodedBits))

	// Write the Rice parameter as the first byte.
	output = append(output, set.riceParameter)

	// Encode the element count using little-endian format.
	var countBuffer [4]byte

	binary.LittleEndian.PutUint32(countBuffer[:], set.elementCount)

	// Append the header and encoded bitstream.
	output = append(output, countBuffer[:]...)
	output = append(output, set.encodedBits...)

	return output
}

// UnmarshalGolombCodedSet reconstructs a Golomb-Coded Set from its binary
// representation, performing basic validation of the header fields.
func UnmarshalGolombCodedSet(data []byte) (*GolombCodedSet, error) {
	// A valid encoding must contain at least the header.
	if len(data) < 5 {
		return nil, errors.New("golomb coded set invalid encoding")
	}

	// Extract and validate the Rice parameter.
	riceParameter := data[0]

	if riceParameter > 63 {
		return nil, errors.New("golomb coded set invalid rice parameter")
	}

	// Decode the element count and copy the encoded payload.
	return &GolombCodedSet{
		riceParameter: riceParameter,
		elementCount:  binary.LittleEndian.Uint32(data[1:5]),
		encodedBits:   append([]byte(nil), data[5:]...),
	}, nil
}

// BuildGolombCodedSet constructs a new Golomb-Coded Set from the provided
// uniformly distributed hash values and Rice parameter.
// The function sorts and delta-encodes the mapped values before applying
// Golomb–Rice encoding. An error is returned if parameters are invalid or
// derived ranges overflow.
func BuildGolombCodedSet(riceParameter uint8, hashedValues []uint64) (*GolombCodedSet, error) {
	// Validate the Rice parameter. Only values in [0, 63] are valid
	// for 64-bit Golomb–Rice encoding.
	if riceParameter > 63 {
		return nil, errors.New("golomb coded set invalid rice parameter")
	}

	elementCount := uint32(len(hashedValues))

	// An empty input produces a valid but empty set.
	if elementCount == 0 {
		return &GolombCodedSet{
			riceParameter: riceParameter,
			elementCount:  0,
			encodedBits:   nil,
		}, nil
	}

	// Compute the mapping range as N * 2^P, where N is the number
	// of elements and P is the Rice parameter.
	rangeMultiplier := uint64(1) << riceParameter
	valueRangeLimit := uint64(elementCount) * rangeMultiplier

	// Detect overflow or degenerate ranges defensively.
	if valueRangeLimit == 0 {
		return nil, errors.New("golomb coded set invalid value range limit")
	}

	// Map each hash value into the target range using fast
	// multiplication-based range reduction.
	mappedValues := make([]uint64, 0, elementCount)

	for _, hashValue := range hashedValues {
		reducedValue := fastRangeReduction(hashValue, valueRangeLimit)
		mappedValues = append(mappedValues, reducedValue)
	}

	// Sort mapped values so that delta encoding produces
	// non-negative, monotonic differences.
	sort.Slice(mappedValues, func(index, next int) bool {
		return mappedValues[index] < mappedValues[next]
	})

	// Convert sorted values into a delta-encoded sequence.
	deltaValues := make([]uint64, 0, elementCount)

	var previousValue uint64

	for index, currentValue := range mappedValues {
		if index == 0 {
			deltaValues = append(deltaValues, currentValue)
		} else {
			deltaValues = append(deltaValues, currentValue-previousValue)
		}

		previousValue = currentValue
	}

	// Encode each delta value using Golomb–Rice coding.
	bitWriter := newBitStreamWriter()

	for _, delta := range deltaValues {
		bitWriter.writeGolombRiceEncodedValue(delta, riceParameter)
	}

	return &GolombCodedSet{
		riceParameter: riceParameter,
		elementCount:  elementCount,
		encodedBits:   bitWriter.finalize(),
	}, nil
}

// Match tests whether the provided hashed value is a member of the set.
// The function returns false if the value is not present or if decoding fails
// due to malformed or truncated encoded data.
func (set *GolombCodedSet) Match(hashedValue uint64) bool {
	// Reject invalid or empty sets defensively.
	if set == nil || set.elementCount == 0 {
		return false
	}

	if set.riceParameter > 63 || len(set.encodedBits) == 0 {
		return false
	}

	// Recompute the mapping range used during construction.
	rangeMultiplier := uint64(1) << set.riceParameter
	valueRangeLimit := uint64(set.elementCount) * rangeMultiplier

	if valueRangeLimit == 0 {
		return false
	}

	// Map the queried hash value into the same reduced domain.
	targetValue := fastRangeReduction(hashedValue, valueRangeLimit)
	bitReader := newBitStreamReader(set.encodedBits)

	var accumulatedValue uint64

	// Decode delta values sequentially and reconstruct the original
	// mapped values until a match is found or the search can terminate.
	for decodedCount := uint32(0); decodedCount < set.elementCount; decodedCount++ {
		if !bitReader.hasRemainingBits() {
			return false
		}

		delta, ok := bitReader.readGolombRiceEncodedValue(set.riceParameter)

		if !ok {
			return false
		}

		// Reconstruct the next mapped value.
		accumulatedValue += delta

		// Any value outside the valid range indicates corruption.
		if accumulatedValue >= valueRangeLimit {
			return false
		}

		// Exact match indicates probable membership.
		if accumulatedValue == targetValue {
			return true
		}

		// Since values are sorted, exceeding the target means
		// it cannot appear later.
		if accumulatedValue > targetValue {
			return false
		}
	}

	return false
}
```
---

`golombcodedset > go_lomb_coded_set_test.go

```go
// -----------------------------------------------------------------------------
// Package: golombcodedset
// File: golomb_coded_set_test.go
//
// Description:
//
//	This file contains unit tests for the golombcodedset package.
//	The tests validate correctness, defensive behavior, and round-trip
//	integrity of Golomb-Coded Set construction, serialization, decoding,
//	and membership queries.
//
//	Each test follows a strict Arrange / Act / Assert structure to ensure
//	readability and consistency with the rest of the codebase.
//
//	The tests intentionally favor clarity and explicitness over compactness
//	and are designed to detect regressions in bit-level encoding logic,
//	range reduction behavior, and decoding safety.
//
// Notes:
//   - All tests use uniformly distributed 64-bit hash values.
//   - Test parameters use the name `test` instead of `t` by design.
//   - No test relies on undefined behavior or implementation details.
//
// -----------------------------------------------------------------------------
package golombcodedset

import (
	"bytes"
	"testing"
)

// TestMultiplyUint64ProducesCorrect128BitProduct verifies that the 128-bit
// multiplication utility produces correct high and low halves for known inputs.
func TestMultiplyUint64ProducesCorrect128BitProduct(test *testing.T) {
	// Arrange.
	var multiplicand uint64 = 0xFFFFFFFFFFFFFFFF
	var multiplier uint64 = 2

	// Act.
	upperHalf, lowerHalf := multiplyUint64(multiplicand, multiplier)

	// Assert.
	if lowerHalf != 0xFFFFFFFFFFFFFFFE {
		test.Fatalf("unexpected lower 64 bits %x", lowerHalf)
	}

	if upperHalf != 1 {
		test.Fatalf("unexpected upper 64 bits %x", upperHalf)
	}
}

// TestFastRangeReductionProducesValuesWithinRange verifies that reduced values
// always fall within the expected half-open interval [0, rangeLimit).
func TestFastRangeReductionProducesValuesWithinRange(test *testing.T) {
	// Arrange.
	var rangeLimit uint64 = 1000
	var inputValues = []uint64{
		0,
		1,
		42,
		123456789,
		0xFFFFFFFFFFFFFFFF,
	}

	// Act / Assert.
	for _, originalValue := range inputValues {
		reducedValue := fastRangeReduction(originalValue, rangeLimit)

		if reducedValue >= rangeLimit {
			test.Fatalf("reduced value %d exceeds range limit %d", reducedValue, rangeLimit)
		}
	}
}

// TestBuildGolombCodedSetAndMatch verifies successful construction and correct
// membership detection for present and absent values.
func TestBuildGolombCodedSetAndMatch(test *testing.T) {
	// Arrange.
	var riceParameter uint8 = 10
	var hashedInputValues = []uint64{
		0x0123456789ABCDEF,
		0x1111111111111111,
		0x2222222222222222,
		0x3333333333333333,
		0x4444444444444444,
	}

	// Act.
	golombSet, buildError := BuildGolombCodedSet(riceParameter, hashedInputValues)

	// Assert.
	if buildError != nil {
		test.Fatalf("unexpected build error %v", buildError)
	}

	for _, presentValue := range hashedInputValues {
		if !golombSet.Match(presentValue) {
			test.Fatalf("expected value %x to be present", presentValue)
		}
	}

	var absentValue uint64 = 0x9999999999999999

	if golombSet.Match(absentValue) {
		test.Fatalf("unexpected match for absent value %x", absentValue)
	}
}

// TestMarshalAndUnmarshalPreservesSet verifies that binary serialization and
// deserialization preserve all observable set behavior.
func TestMarshalAndUnmarshalPreservesSet(test *testing.T) {
	// Arrange.
	var riceParameter uint8 = 8
	var hashedInputValues = []uint64{
		0xAAAAAAAAAAAAAAAA,
		0xBBBBBBBBBBBBBBBB,
		0xCCCCCCCCCCCCCCCC,
	}

	originalSet, buildError := BuildGolombCodedSet(riceParameter, hashedInputValues)

	if buildError != nil {
		test.Fatalf("unexpected build error %v", buildError)
	}

	// Act.
	serializedBytes := originalSet.MarshalBinary()
	decodedSet, decodeError := UnmarshalGolombCodedSet(serializedBytes)

	// Assert.
	if decodeError != nil {
		test.Fatalf("unexpected decode error %v", decodeError)
	}

	for _, expectedValue := range hashedInputValues {
		if !decodedSet.Match(expectedValue) {
			test.Fatalf("expected value %x missing after decode", expectedValue)
		}
	}
}

// TestEmptyGolombCodedSetBehavior verifies that empty sets are valid,
// serializable, and never match any values.
func TestEmptyGolombCodedSetBehavior(test *testing.T) {
	// Arrange.
	var riceParameter uint8 = 5
	var emptyValueSlice []uint64

	// Act.
	emptySet, buildError := BuildGolombCodedSet(riceParameter, emptyValueSlice)

	// Assert.
	if buildError != nil {
		test.Fatalf("unexpected build error %v", buildError)
	}

	if emptySet.Match(0x1234567890ABCDEF) {
		test.Fatalf("empty set should not match any value")
	}

	serializedBytes := emptySet.MarshalBinary()

	if len(serializedBytes) == 0 {
		test.Fatalf("expected non-empty serialization for empty set")
	}
}

// TestBitStreamWriterAndReaderRoundTrip verifies that values written via the
// bit stream writer can be read back losslessly by the reader.
func TestBitStreamWriterAndReaderRoundTrip(test *testing.T) {
	// Arrange.
	var riceParameter uint8 = 6
	var originalValues = []uint64{0, 1, 5, 17, 64, 255}

	bitWriter := newBitStreamWriter()

	// Act.
	for _, value := range originalValues {
		bitWriter.writeGolombRiceEncodedValue(value, riceParameter)
	}

	encodedBuffer := bitWriter.finalize()
	bitReader := newBitStreamReader(encodedBuffer)

	// Assert.
	for _, expectedValue := range originalValues {
		decodedValue, ok := bitReader.readGolombRiceEncodedValue(riceParameter)

		if !ok {
			test.Fatalf("failed to decode value %d", expectedValue)
		}

		if decodedValue != expectedValue {
			test.Fatalf("decoded value %d does not match expected %d", decodedValue, expectedValue)
		}
	}
}

// TestUnmarshalRejectsInvalidHeader verifies that malformed serialized data
// is rejected during deserialization.
func TestUnmarshalRejectsInvalidHeader(test *testing.T) {
	// Arrange.
	var invalidSerializedData = []byte{0xFF}

	// Act.
	decodedSet, decodeError := UnmarshalGolombCodedSet(invalidSerializedData)

	// Assert.
	if decodeError == nil {
		test.Fatalf("expected decode error but got nil set %v", decodedSet)
	}
}

// TestSerializedOutputIsDeterministic verifies that serialization output
// is stable for identical inputs.
func TestSerializedOutputIsDeterministic(test *testing.T) {
	// Arrange.
	var riceParameter uint8 = 7
	var hashedInputValues = []uint64{
		0xDEADBEEFDEADBEEF,
		0xCAFEBABECAFEBABE,
	}

	firstSet, _ := BuildGolombCodedSet(riceParameter, hashedInputValues)
	secondSet, _ := BuildGolombCodedSet(riceParameter, hashedInputValues)

	// Act.
	firstBytes := firstSet.MarshalBinary()
	secondBytes := secondSet.MarshalBinary()

	// Assert.
	if !bytes.Equal(firstBytes, secondBytes) {
		test.Fatalf("serialization output is not deterministic")
	}
}
```
---

## 10.3 Native Go Fuzzing (`testing.F`) & Malformed Input Defense

While table-driven unit tests verify expected paths and benchmarks measure execution speed, they are inherently limited by human imagination. When engineering low-level persistence engines, network protocols, or binary deserializers (such as our Golomb-Coded Set unmarshaler), malformed or adversarial inputs can trigger unexpected panics, out-of-bounds memory slices, or infinite loops in variable-length bitstream decoding.

Go's native fuzzing engine (`testing.F`) bridges this gap by automatically mutating a seed corpus to generate thousands of test cases, probing edge cases that static test vectors miss.

The following production-grade fuzz test targets UnmarshalGolombCodedSet, ensuring that arbitrary, truncated, or corrupted byte sequences fail defensively with controlled errors rather than panicking the process.

```go
package golombcodedset

import (
	"testing"
)

// FuzzUnmarshalGolombCodedSet fuzzes binary unmarshaling with randomized byte streams
// to guarantee defensive error handling and prevent out-of-bounds panics.
func FuzzUnmarshalGolombCodedSet(fuzz *testing.F) {
	// 1. Seed corpus with valid serialization output.
	validSet, buildError := BuildGolombCodedSet(8, []uint64{100, 200, 300, 400})
	if buildError == nil {
		fuzz.Add(validSet.MarshalBinary())
	}

	// 2. Add edge-case seed inputs (empty payload, short headers, out-of-bound parameters).
	fuzz.Add([]byte{})
	fuzz.Add([]byte{0x00})
	fuzz.Add([]byte{0xFF, 0x00, 0x00, 0x00, 0x00})
	fuzz.Add([]byte{0x08, 0x01, 0x00, 0x00, 0x00, 0xFF, 0xFF})

	// 3. Execute the fuzzing loop across mutated byte sequences.
	fuzz.Fuzz(func(test *testing.T, data []byte) {
		// Unmarshaling must return either a valid set or a controlled error.
		// It must never panic under any adversarial input configuration.
		decodedSet, decodeError := UnmarshalGolombCodedSet(data)

		if decodeError != nil {
			return // Controlled rejection of malformed data is correct behavior.
		}

		// If successfully decoded, match queries must also execute safely without panicking.
		if decodedSet != nil {
			_ = decodedSet.Match(12345)
		}
	})
}

// FuzzBuildGolombCodedSet fuzzes set construction with arbitrary Rice parameters
// and raw byte slices converted to hash values to verify defensive bounds checking.
func FuzzBuildGolombCodedSet(fuzz *testing.F) {
	fuzz.Add(uint8(8), []byte{0xEF, 0xBE, 0xAD, 0xDE, 0xEF, 0xBE, 0xAD, 0xDE})
	fuzz.Add(uint8(100), []byte{0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07})

	fuzz.Fuzz(func(test *testing.T, riceParameter uint8, rawPayload []byte) {
		// Extract 64-bit hash values from the raw byte slice.
		hashedValues := make([]uint64, 0, len(rawPayload)/8)

		for index := 0; index+8 <= len(rawPayload); index += 8 {
			value := uint64(rawPayload[index]) |
				uint64(rawPayload[index+1])<<8 |
				uint64(rawPayload[index+2])<<16 |
				uint64(rawPayload[index+3])<<24 |
				uint64(rawPayload[index+4])<<32 |
				uint64(rawPayload[index+5])<<40 |
				uint64(rawPayload[index+6])<<48 |
				uint64(rawPayload[index+7])<<56
			hashedValues = append(hashedValues, value)
		}

		_, buildError := BuildGolombCodedSet(riceParameter, hashedValues)

		if buildError != nil {
			return // Controlled rejection of invalid parameters or states.
		}
	})
}

// FuzzBitStreamReader fuzzes the bit-level stream reader against arbitrary 
// byte streams to guarantee that malformed bitstreams never trigger panics or out-of-bounds reads.
func FuzzBitStreamReader(fuzz *testing.F) {
	fuzz.Add([]byte{0xAA, 0x55, 0xFF, 0x00}, uint8(4))
	fuzz.Add([]byte{}, uint8(0))

	fuzz.Fuzz(func(test *testing.T, encodedBits []byte, riceParameter uint8) {
		reader := newBitStreamReader(encodedBits)

		// Exercise reader methods defensively until exhaustion.
		for reader.hasRemainingBits() {
			_, _ = reader.readGolombRiceEncodedValue(riceParameter)
		}
	})
}
```
